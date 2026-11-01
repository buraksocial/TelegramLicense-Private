/**
 * AIVault Hub adapter — https://reseller.aivaulthub.store
 *
 * Catalog: GET /api/v1/products -> { products:[{service_id,name,stock,pricing_tiers,bulk_discounts}] }
 * Balance: GET /api/v1/me        -> { balance, currency:'USD' }
 * Order:   POST /api/v1/order    -> { success, order_id, products[], total_cost, new_balance }
 *          supports external_order_id (idempotency) and accept_normal_price override.
 * Rate: 60 req/min. Prices in USD, fixed 1$ = 100 INR on their side (we never touch INR).
 */
const { supplierRequest } = require('../supplierHttp');

const ENDPOINTS = { catalog: '/api/v1/products', me: '/api/v1/me', order: '/api/v1/order' };

function toTiers(product) {
  const tiers = Array.isArray(product.pricing_tiers) ? product.pricing_tiers : [];
  if (!tiers.length) {
    return null;
  }
  return tiers.map((t) => ({
    min: parseInt(t.min, 10) || 1,
    max: t.max === null || t.max === undefined ? Infinity : parseInt(t.max, 10),
    price: parseFloat(t.price)
  }));
}

async function fetchCatalog(supplier) {
  const data = await supplierRequest(supplier, { method: 'GET', url: ENDPOINTS.catalog });
  const list = Array.isArray(data) ? data : data.products || data.services || [];
  return list.map((p) => {
    const tiers = toTiers(p);
    const basePrice = tiers ? tiers[0].price : parseFloat(p.price ?? p.base_price ?? 0);
    return {
      remote_service_id: String(p.service_id ?? p.id),
      name: p.name || '',
      description: p.description || '',
      category_raw: p.category || '',
      price_usd: basePrice,
      stock: Number.isFinite(+p.stock) ? parseInt(p.stock, 10) : null,
      tiers: tiers || [{ min: 1, max: Infinity, price: basePrice }],
      bulk_discounts: p.bulk_discounts || [],
      currency: 'USD'
    };
  });
}

async function getBalance(supplier) {
  const data = await supplierRequest(supplier, { method: 'GET', url: ENDPOINTS.me });
  if (data && Number.isFinite(+data.balance)) return parseFloat(data.balance);
  return null; // never pretend to be infinite
}

async function placeOrder(supplier, { remote_service_id, quantity, idempotency_key, accept_normal_price }) {
  const body = { service_id: remote_service_id, quantity };
  if (idempotency_key) body.external_order_id = idempotency_key;
  if (accept_normal_price) body.accept_normal_price = true;

  let data;
  try {
    data = await supplierRequest(supplier, { method: 'POST', url: ENDPOINTS.order, data: body });
  } catch (err) {
    // "API purchases require a buffer of 100 stock. Available for API: 0"
    const m = /Available for API:\s*(\d+)/i.exec(err.apiMessage || err.message || '');
    if (m) {
      err.stockHint = parseInt(m[1], 10);
      err.code = 'BUFFER_LIMIT';
    }
    throw err;
  }

  const ok = data && (data.success === true || data.status === 'success');
  if (!ok) {
    throw Object.assign(new Error(data?.message || data?.error || 'AIVault order rejected'), {
      apiData: data,
      code: data?.code || 'ORDER_REJECTED'
    });
  }
  return {
    deliveries: Array.isArray(data.products) ? data.products : [],
    order_id: data.order_id || null,
    spent_usd: Number.isFinite(+data.total_cost) ? parseFloat(data.total_cost) : null,
    balance_after: Number.isFinite(+data.new_balance) ? parseFloat(data.new_balance) : null,
    raw: data
  };
}

module.exports = { type: 'aivault', fetchCatalog, getBalance, placeOrder };
