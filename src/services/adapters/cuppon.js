/**
 * Cuppon'sHub adapter — https://cupponhub.shop/reseller/api/
 *
 * Completely different shape: action-based query params, not REST paths.
 *   GET  ?action=balance            -> { ok, balance_usdt: "12.500000" }
 *   GET  ?action=products           -> { ok, products:[{key,name,stock,price_usdt_from,max_quantity,...}] }
 *   POST ?action=purchase           -> 201 { ok, order:{ order_id, items[], total_usdt, balance_after } }
 *        requires Idempotency-Key header (safe retries)
 *   GET  ?action=order&order_id=... -> order recovery
 * Rate: 60 req/min. Prices are 6-decimal USDT strings.
 */
const crypto = require('crypto');
const { supplierRequest } = require('../supplierHttp');

const BASE = '/reseller/api/';

function toTiers(product) {
  // price_usdt_from is the qty-1 price; Cuppon has no published tier slabs.
  const price = parseFloat(product.price_usdt_from);
  return [{ min: 1, max: Infinity, price: Number.isFinite(price) ? price : 0 }];
}

async function fetchCatalog(supplier) {
  const data = await supplierRequest(supplier, {
    method: 'GET',
    url: BASE,
    params: { action: 'products' }
  });
  const list = data.products || [];
  return list.map((p) => ({
    remote_service_id: String(p.key),
    name: p.name || '',
    description: p.description || '',
    category_raw: p.category || p.subcategory || '',
    price_usd: parseFloat(p.price_usdt_from) || 0,
    stock: Number.isFinite(+p.stock) ? parseInt(p.stock, 10) : null,
    max_quantity: parseInt(p.max_quantity, 10) || null,
    tiers: toTiers(p),
    currency: 'USDT',
    meta: {
      duration: p.duration || '',
      region: p.region || '',
      warranty: p.warranty || '',
      delivery_format: p.delivery_format || ''
    }
  }));
}

async function getBalance(supplier) {
  const data = await supplierRequest(supplier, { method: 'GET', url: BASE, params: { action: 'balance' } });
  const v = parseFloat(data.balance_usdt ?? data.balance);
  return Number.isFinite(v) ? v : null;
}

async function placeOrder(supplier, { remote_service_id, quantity, idempotency_key }) {
  const key = idempotency_key || `cuppon_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const data = await supplierRequest(supplier, {
    method: 'POST',
    url: BASE,
    params: { action: 'purchase' },
    headers: { 'Idempotency-Key': key },
    data: { product: remote_service_id, quantity }
  });

  const order = data.order || data;
  const ok = data.ok === true || order.status === 'completed';
  if (!ok) {
    throw Object.assign(new Error(data.error || order.error || 'Cuppon order rejected'), {
      apiData: data,
      code: data.error || 'ORDER_REJECTED'
    });
  }
  return {
    deliveries: Array.isArray(order.items) ? order.items : [],
    order_id: order.order_id || null,
    spent_usd: Number.isFinite(+order.total_usdt) ? parseFloat(order.total_usdt) : null,
    balance_after: Number.isFinite(+order.balance_after) ? parseFloat(order.balance_after) : null,
    stock_left: Number.isFinite(+order.stock_left) ? parseInt(order.stock_left, 10) : null,
    idempotent_replay: data.idempotent_replay === true,
    raw: data
  };
}

/** Order recovery for reconciliation after a dropped connection. */
async function getOrder(supplier, orderId) {
  const data = await supplierRequest(supplier, {
    method: 'GET',
    url: BASE,
    params: { action: 'order', order_id: orderId }
  });
  return data.order || null;
}

module.exports = { type: 'cuppon', fetchCatalog, getBalance, placeOrder, getOrder };
