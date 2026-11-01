/**
 * LootPaglu adapter — https://lootpaglu.in
 *
 *   GET  /api/v1/me        -> { userId, wallet_inr, wallet_crypto, total_spent }
 *   GET  /api/v1/products  -> { services:[{service_id,name,available_stock,prices:{upiPrice,cryptoPrice}}] }
 *   POST /api/v1/order     -> Idempotency-Key header; { products:[...] }
 * Dual wallet: INR (upiPrice) and crypto/USDT (cryptoPrice). We ALWAYS settle
 * in crypto (USD-equivalent) so the pricing engine never mixes currencies.
 * Rate: 3 req/s.
 */
const crypto = require('crypto');
const { supplierRequest } = require('../supplierHttp');

async function fetchCatalog(supplier) {
  const data = await supplierRequest(supplier, { method: 'GET', url: '/api/v1/products' });
  const list = data.services || data.products || [];
  return list.map((p) => {
    const cryptoPrice = parseFloat(p.prices?.cryptoPrice ?? p.cryptoPrice ?? 0);
    const tiers =
      Array.isArray(p.slots) && p.slots.length
        ? p.slots.map((s) => ({
            min: parseInt(s.min, 10) || 1,
            max: s.max === null || s.max === undefined ? Infinity : parseInt(s.max, 10),
            price: parseFloat(s.cryptoPrice ?? s.price ?? 0)
          }))
        : [{ min: 1, max: Infinity, price: cryptoPrice }];
    return {
      remote_service_id: String(p.service_id ?? p.id),
      name: p.name || '',
      description: p.description || '',
      category_raw: p.category || '',
      price_usd: cryptoPrice,
      price_inr: parseFloat(p.prices?.upiPrice ?? p.upiPrice ?? 0) || null,
      stock: Number.isFinite(+(p.available_stock ?? p.stock)) ? parseInt(p.available_stock ?? p.stock, 10) : null,
      tiers,
      currency: 'USDT',
      accepted_currencies: p.accepted_currencies || ['crypto']
    };
  });
}

async function getBalance(supplier) {
  const data = await supplierRequest(supplier, { method: 'GET', url: '/api/v1/me' });
  const v = parseFloat(data.wallet_crypto);
  return Number.isFinite(v) ? v : null;
}

async function placeOrder(supplier, { remote_service_id, quantity, idempotency_key }) {
  const key = idempotency_key || `paglu_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const data = await supplierRequest(supplier, {
    method: 'POST',
    url: '/api/v1/order',
    headers: { 'Idempotency-Key': key },
    data: { service_id: remote_service_id, quantity, currency: 'crypto' }
  });

  const ok = data && (data.success === true || data.status === 'success');
  if (!ok) {
    throw Object.assign(new Error(data?.error || data?.message || 'LootPaglu order rejected'), {
      apiData: data,
      code: 'ORDER_REJECTED'
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

module.exports = { type: 'lootpaglu', fetchCatalog, getBalance, placeOrder };
