/**
 * Shared HTTP layer for every supplier adapter.
 *
 * Responsibilities:
 *  - route every call through the per-supplier/per-endpoint RateGovernor
 *  - one automatic retry on 429/5xx/network after the bucket backs off
 *  - normalise failures into SupplierError with .status / .apiMessage so
 *    callers can distinguish "insufficient balance" / "out of stock" /
 *    "rate limited" / "unreachable" without parsing raw axios noise
 *  - never log the API key
 */
const axios = require('axios');
const { getGovernor } = require('./RateGovernor');

class SupplierError extends Error {
  constructor(message, { status = null, apiMessage = null, code = null, retryable = false } = {}) {
    super(message);
    this.name = 'SupplierError';
    this.status = status;
    this.apiMessage = apiMessage;
    this.code = code;
    this.retryable = retryable;
  }
}

function extractApiMessage(data) {
  if (!data) return null;
  if (typeof data === 'string') return data.slice(0, 300);
  return data.error || data.message || data.detail || data.reason || null;
}

function retryAfterMs(err) {
  const h = err.response?.headers?.['retry-after'];
  if (!h) return null;
  const secs = parseFloat(h);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 60000);
  const date = Date.parse(h);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 60000);
  return null;
}

/**
 * @param supplier row ({id, type, base_url, api_key})
 * @param opts { method, url, params, data, headers, timeout }
 */
async function supplierRequest(supplier, opts) {
  const governor = getGovernor(supplier);
  const endpoint = opts.url;
  const timeout = opts.timeout || 15000;

  const client = axios.create({
    baseURL: supplier.base_url || undefined,
    timeout,
    headers: {
      'X-API-Key': supplier.api_key,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'ngrok-skip-browser-warning': 'true',
      ...(opts.headers || {})
    },
    validateStatus: () => true // we classify statuses ourselves
  });

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    await governor.acquire(endpoint);
    let res;
    try {
      res = await client.request({
        method: opts.method || 'GET',
        url: opts.url,
        params: opts.params,
        data: opts.data
      });
    } catch (err) {
      lastErr = err;
      // network / timeout -> back off and retry once
      governor.penalize(endpoint, 3000);
      if (attempt === 0) continue;
      throw new SupplierError(`${supplier.type}: network error (${err.code || err.message})`, {
        code: 'NETWORK',
        retryable: true
      });
    }

    if (res.status >= 200 && res.status < 300) {
      return res.data;
    }

    const apiMessage = extractApiMessage(res.data);

    if (res.status === 429 || res.status >= 500) {
      lastErr = res;
      governor.penalize(endpoint, retryAfterMs({ response: res }) || (res.status === 429 ? 10000 : 3000));
      if (attempt === 0) continue;
      throw new SupplierError(`${supplier.type}: HTTP ${res.status} ${apiMessage || ''}`.trim(), {
        status: res.status,
        apiMessage,
        code: res.status === 429 ? 'RATE_LIMIT' : 'SERVER',
        retryable: true
      });
    }

    // 4xx that is not rate limit: caller decides what to do with it.
    throw new SupplierError(`${supplier.type}: HTTP ${res.status} ${apiMessage || ''}`.trim(), {
      status: res.status,
      apiMessage,
      code:
        res.status === 401 || res.status === 403
          ? 'AUTH'
          : res.status === 402
            ? 'INSUFFICIENT_BALANCE'
            : res.status === 404
              ? 'NOT_FOUND'
              : res.status === 409
                ? 'CONFLICT'
                : 'CLIENT',
      retryable: false
    });
  }

  throw new SupplierError(`${supplier.type}: request failed after retries`, { retryable: true });
}

module.exports = { supplierRequest, SupplierError, extractApiMessage };
