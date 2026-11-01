/**
 * ratelimit — dependency-free token bucket + daily quota.
 *
 * Design:
 *  - TokenBucket: continuous refill (no fixed-window bursts at boundary).
 *      capacity = burst tokens, refill = rate per second.
 *  - Quota: fixed UTC-day counter (daily request cap).
 *  - Weighted costs: a catalog read costs 1, an order costs 5 — abuse of the
 *    expensive endpoints is throttled proportionally.
 *  - Memory: one entry per key/IP, swept every 15 min (idle entries drop).
 */
class TokenBucket {
  /** @param {number} ratePerMin sustained requests/minute @param {number} burst bucket capacity */
  constructor(ratePerMin, burst) {
    this.rate = ratePerMin / 60;                    // tokens per second
    this.capacity = Math.max(1, burst || Math.ceil(ratePerMin / 6));
    this.tokens = this.capacity;
    this.updated = Date.now();
  }

  /** @returns {{allowed:boolean, remaining:number, retryAfter:number}} retryAfter in seconds */
  take(cost = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.updated) / 1000) * this.rate);
    this.updated = now;
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true, remaining: Math.floor(this.tokens), retryAfter: 0 };
    }
    const need = cost - this.tokens;
    return { allowed: false, remaining: 0, retryAfter: Math.max(1, Math.ceil(need / this.rate)) };
  }
}

class DailyQuota {
  constructor(limit) { this.limit = limit; this.day = null; this.count = 0; }
  hit() {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.count = 0; }
    this.count++;
    return { exceeded: this.limit != null && this.count > this.limit, used: this.count, limit: this.limit };
  }
}

/** Registry that owns buckets/quotas per identity and sweeps stale ones. */
class RateRegistry {
  constructor({ sweepMs = 15 * 60 * 1000, idleMs = 60 * 60 * 1000 } = {}) {
    this.buckets = new Map();   // id -> TokenBucket
    this.quotas = new Map();    // id -> DailyQuota
    this.lastSeen = new Map();  // id -> ts
    this._timer = null;
    this.sweepMs = sweepMs;
    this.idleMs = idleMs;
  }

  /**
   * @param {string} id        e.g. 'key:12' or 'ip:1.2.3.4'
   * @param {number} ratePerMin sustained rate for this identity
   * @param {number} cost      weighted request cost
   * @param {number|null} dailyLimit optional UTC-day cap
   */
  consume(id, ratePerMin, cost, dailyLimit = null) {
    let b = this.buckets.get(id);
    if (!b || Math.abs(b.rate * 60 - ratePerMin) > 0.01) {
      b = new TokenBucket(ratePerMin, Math.max(cost, Math.ceil(ratePerMin / 6)));
      this.buckets.set(id, b);
    }
    const r = b.take(cost);
    this.lastSeen.set(id, Date.now());
    let q = null;
    if (dailyLimit != null) {
      q = this.quotas.get(id) || new DailyQuota(dailyLimit);
      this.quotas.set(id, q);
    }
    const quota = q ? q.hit() : { exceeded: false, used: this.buckets.size, limit: null };
    if (r.allowed && quota.exceeded) {
      return { allowed: false, limitedBy: 'daily', remaining: 0, retryAfter: secondsToMidnight(), used: quota.used, limit: quota.limit };
    }
    return {
      allowed: r.allowed,
      limitedBy: r.allowed ? null : 'rate',
      remaining: r.remaining,
      retryAfter: r.retryAfter,
      used: quota.used,
      limit: quota.limit
    };
  }

  reset(id) { this.buckets.delete(id); this.quotas.delete(id); this.lastSeen.delete(id); }

  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => this.sweep(), this.sweepMs);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  sweep() {
    const cut = Date.now() - this.idleMs;
    for (const [id, ts] of this.lastSeen) {
      if (ts < cut) { this.buckets.delete(id); this.quotas.delete(id); this.lastSeen.delete(id); }
    }
  }
}

function secondsToMidnight() {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.round((midnight - now.getTime()) / 1000));
}

module.exports = { TokenBucket, DailyQuota, RateRegistry, secondsToMidnight };
