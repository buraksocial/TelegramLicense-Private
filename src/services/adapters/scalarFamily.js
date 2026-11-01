/**
 * Scalar-family adapter factory (AIVerseX Hub + Unique AI Zone).
 *
 * Both bots run the same platform (openapi at <base>/openapi.json):
 *   GET  /api/v1/me        -> { chat_id, wallet_balance }
 *   GET  /api/v1/products  -> { services:[{service_id,name,price,stock}] }
 *   POST /api/v1/order     -> { success, order_id, products[], total_cost, new_balance }
 *
 * Rate limit is the platform's defining hazard: 1 request / 10s PER ENDPOINT.
 * The old implementation cached at module level, so AIVerseX and UniqueAI
 * shared one products cache and cross-contaminated each other. Each supplier
 * now gets its OWN instance (own cache, own governor via RateGovernor), and
 * the cache is keyed by supplier id + service id.
 *
 * Also fixed vs the legacy adapter:
 *   - missing wallet_balance => null (was Infinity -> phantom unlimited funds)
 *   - success:false / status:error responses now throw (were treated as OK)
 *   - "buffer of N stock. Available for API: X" errors clamp per-service stock
 *   - ENABLE_MANUAL_FALLBACK replaced by supplier-level manual_fallback flag
 */
const { supplierRequest } = require('../supplierHttp');
const { SUPPLIER_DRY_RUN } = require('../../config/env');

// Per-instance caches are created by createAdapter(); nothing is global.
function createAdapter(typeName) {
  const instanceCache = {
    balance: new Map(), // supplierId -> { value, expires }
    catalog: new Map(), // supplierId -> { services, expires }
    stockClamp: new Map() // `${supplierId}:${serviceId}` -> { value, expires }
  };
  const BALANCE_TTL = 15000;
  const CATALOG_TTL = 30000; // governor already enforces >=10.5s between calls

  function supplierKey(supplier) {
    return `${supplier.id ?? supplier.base_url}`;
  }

  async function fetchCatalog(supplier, { force = false } = {}) {
    const sk = supplierKey(supplier);
    const hit = instanceCache.catalog.get(sk);
    if (!force && hit && hit.expires > Date.now()) return hit.services;

    const data = await supplierRequest(supplier, { method: 'GET', url: '/api/v1/products' });
    const list = data.services || data.products || (Array.isArray(data) ? data : []);
    const services = list.map((p) => {
      const price = parseFloat(p.price ?? 0);
      return {
        remote_service_id: String(p.service_id ?? p.id),
        name: p.name || '',
        description: p.description || '',
        category_raw: p.category || '',
        price_usd: price,
        stock: Number.isFinite(+(p.stock ?? p.available_for_api ?? p.api_stock))
          ? parseInt(p.stock ?? p.available_for_api ?? p.api_stock, 10)
          : null,
        tiers: [{ min: 1, max: Infinity, price }],
        currency: 'USDT'
      };
    });
    instanceCache.catalog.set(sk, { services, expires: Date.now() + CATALOG_TTL });
    return services;
  }

  async function getBalance(supplier) {
    const sk = supplierKey(supplier);
    const hit = instanceCache.balance.get(sk);
    if (hit && hit.expires > Date.now()) return hit.value;
    const data = await supplierRequest(supplier, { method: 'GET', url: '/api/v1/me' });
    const v = parseFloat(data.wallet_balance ?? data.balance);
    const value = Number.isFinite(v) ? v : null; // never Infinity on missing field
    instanceCache.balance.set(sk, { value, expires: Date.now() + BALANCE_TTL });
    return value;
  }

  async function placeOrder(supplier, { remote_service_id, quantity, idempotency_key }) {
    if (SUPPLIER_DRY_RUN) {
      return {
        deliveries: Array.from({ length: quantity }, () => `DRYRUN-${typeName}-${Date.now()}`),
        order_id: `dryrun_${Date.now()}`,
        spent_usd: 0,
        balance_after: null,
        dry_run: true
      };
    }

    const serviceStr = String(remote_service_id);
    const clampKey = `${supplierKey(supplier)}:${serviceStr}`;
    const body = { service_id: remote_service_id, quantity };
    if (idempotency_key) body.external_order_id = idempotency_key;

    let data;
    try {
      data = await supplierRequest(supplier, { method: 'POST', url: '/api/v1/order', data: body });
    } catch (err) {
      const msg = err.apiMessage || err.message || '';
      const m = /Available for API:\s*(\d+)/i.exec(msg);
      if (m) {
        // Platform reserves a stock buffer from API purchases; clamp locally.
        instanceCache.stockClamp.set(clampKey, { value: parseInt(m[1], 10), expires: Date.now() + 30000 });
      }
      throw err;
    }

    // Legacy bug: only status==='error' was checked; success:false slipped through.
    const ok = data && data.success === true && Array.isArray(data.products);
    if (!ok) {
      instanceCache.balance.delete(supplierKey(supplier)); // refresh balance next time
      throw Object.assign(new Error(data?.message || data?.error || `${typeName} order rejected`), {
        apiData: data,
        code: 'ORDER_REJECTED'
      });
    }

    instanceCache.stockClamp.delete(clampKey);
    instanceCache.balance.delete(supplierKey(supplier));
    return {
      deliveries: data.products,
      order_id: data.order_id || null,
      spent_usd: Number.isFinite(+data.total_cost) ? parseFloat(data.total_cost) : null,
      balance_after: Number.isFinite(+data.new_balance) ? parseFloat(data.new_balance) : null,
      raw: data
    };
  }

  /** Local stock clamp from a previous buffer-limit error. */
  function getStockClamp(supplier, remote_service_id) {
    const e = instanceCache.stockClamp.get(`${supplierKey(supplier)}:${String(remote_service_id)}`);
    return e && e.expires > Date.now() ? e.value : null;
  }

  return { type: typeName, fetchCatalog, getBalance, placeOrder, getStockClamp };
}

module.exports = { createAdapter };
