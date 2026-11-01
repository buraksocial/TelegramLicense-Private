/**
 * Per-supplier request governor.
 *
 * Every HTTP call a supplier adapter makes goes through acquire(endpoint)
 * first. Implementation: sliding-window counter per endpoint + min interval
 * per endpoint + single-flight queue + Retry-After respect.
 *
 * When the budget is exhausted callers WAIT (queued) instead of firing and
 * eating a 429 — this is what keeps AIVerseX (1 req/10s PER ENDPOINT) and the
 * 60/min panels happy even though ReservationManager and the catalog poller
 * both want data at once. Order placement uses its own endpoint bucket so a
 * slow /products cadence never delays a checkout.
 */
const { RATE_LIMITS } = require('../constants');

class Bucket {
  constructor(limit, windowMs, minIntervalMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.minIntervalMs = minIntervalMs || 0;
    this.stamps = [];
    this.last = 0; // last fired request; NEVER pruned (min-interval memory)
    this.pausedUntil = 0;
    this.queue = Promise.resolve();
  }

  waitTime(now = Date.now()) {
    if (now < this.pausedUntil) return this.pausedUntil - now;
    const cutoff = now - this.windowMs;
    while (this.stamps.length && this.stamps[0] <= cutoff) this.stamps.shift();
    let w = 0;
    if (this.stamps.length >= this.limit) {
      w = Math.max(w, this.stamps[0] + this.windowMs - now);
    }
    if (this.last) {
      w = Math.max(w, this.last + this.minIntervalMs - now);
    }
    return Math.max(0, w);
  }

  acquire() {
    const step = async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const wait = this.waitTime();
        if (wait <= 0) {
          this.stamps.push(Date.now());
          this.last = Date.now();
          return;
        }
        await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
      }
    };
    this.queue = this.queue.then(step, step);
    return this.queue;
  }

  penalize(retryAfterMs) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + Math.min(retryAfterMs || this.windowMs, 60000));
  }
}

class Governor {
  constructor(supplier) {
    this.name = `${supplier.type}#${supplier.id ?? 0}`;
    this.rl = RATE_LIMITS[supplier.type] || { requests: 10, window_ms: 60000, min_interval_ms: 0 };
    this.buckets = new Map();
    this.shared = !!this.rl.shared;
  }

  bucket(endpoint) {
    // Shared mode: the platform counts requests per API key across ALL
    // endpoints, so every call funnels through one bucket.
    const key = this.shared ? '*' : String(endpoint).split('?')[0];
    if (!this.buckets.has(key)) {
      this.buckets.set(key, new Bucket(this.rl.requests, this.rl.window_ms, this.rl.min_interval_ms));
    }
    return this.buckets.get(key);
  }

  acquire(endpoint) {
    return this.bucket(endpoint).acquire();
  }

  penalize(endpoint, retryAfterMs) {
    this.bucket(endpoint).penalize(retryAfterMs);
  }

  /** ms until next request to endpoint would be allowed (0 = ready). */
  waitTime(endpoint) {
    return this.bucket(endpoint).waitTime();
  }
}

const governors = new Map();

function getGovernor(supplier) {
  const key = `${supplier.type}#${supplier.id ?? 0}`;
  if (!governors.has(key)) governors.set(key, new Governor(supplier));
  return governors.get(key);
}

module.exports = { getGovernor, Governor };
