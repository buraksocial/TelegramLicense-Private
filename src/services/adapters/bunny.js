/**
 * Bunny AI adapter — https://bunnytoolsbot.tech
 *
 *   GET  /api/v1/profile          -> { merchant_id, balance, total_spent, ... }
 *   GET  /api/v1/products         -> { products:[{product_id,name,base_price,stock_count,description,category}] }
 *   GET  /api/v1/pricing          -> per-product selling_price + base_price (what we may resell at)
 *   POST /api/v1/order/create     -> { order:{ order_code, delivered_item, base_price } }
 *        PRICE PROTECTION: body.selling_price is REQUIRED and must be >= base_price
 *        or the order is rejected outright. delivered_item is a SINGLE string,
 *        even for quantity > 1 (they deliver one item per call in practice).
 * Descriptions contain <tg-emoji emoji-id="...">...</tg-emoji> markup -> stripped here.
 */
const { supplierRequest } = require('../supplierHttp');

const TG_EMOJI_RE = /<tg-emoji[^>]*>([^<]*)<\/tg-emoji>/g;

function cleanDescription(text) {
  if (!text) return '';
  return String(text).replace(TG_EMOJI_RE, '$1').replace(/\r\n/g, '\n').trim();
}

async function fetchCatalog(supplier) {
  const data = await supplierRequest(supplier, { method: 'GET', url: '/api/v1/products' });
  const list = data.products || (Array.isArray(data) ? data : []);
  return list.map((p) => {
    const price = parseFloat(p.base_price ?? p.price ?? 0);
    return {
      remote_service_id: String(p.product_id ?? p.id),
      name: (p.name || '').trim(),
      description: cleanDescription(p.description),
      category_raw: p.category || p.category_name || '',
      price_usd: price,
      stock: Number.isFinite(+(p.stock_count ?? p.stock)) ? parseInt(p.stock_count ?? p.stock, 10) : null,
      stock_type: p.stock_type || 'unique',
      tiers: [{ min: 1, max: Infinity, price }],
      currency: 'USD'
    };
  });
}

async function getBalance(supplier) {
  const data = await supplierRequest(supplier, { method: 'GET', url: '/api/v1/profile' });
  const m = data.merchant || data;
  const v = parseFloat(m.balance ?? m.wallet_balance);
  return Number.isFinite(v) ? v : null;
}

/**
 * @param ctx.selling_price_usd our customer-facing price for one unit. Bunny
 *        refuses orders where selling_price < base_price, so the caller
 *        (SupplierManager) must pass the price the customer actually paid.
 */
async function placeOrder(supplier, { remote_service_id, quantity, selling_price_usd }) {
  let base = selling_price_usd;
  if (!Number.isFinite(+base) || +base <= 0) {
    // Fall back to the wholesale base price so the floor check passes.
    const catalog = await fetchCatalog(supplier).catch(() => []);
    const found = catalog.find((c) => c.remote_service_id === String(remote_service_id));
    base = found ? found.price_usd : 0;
  }

  const delivered = [];
  let orderId = null;
  let spent = 0;
  let balanceAfter = null;
  const calls = Math.max(1, parseInt(quantity, 10) || 1);

  // Bunny delivers a single item per call; loop for multi-quantity orders.
  for (let i = 0; i < calls; i++) {
    const data = await supplierRequest(supplier, {
      method: 'POST',
      url: '/api/v1/order/create',
      data: { product_id: parseInt(remote_service_id, 10), quantity: 1, selling_price: +base }
    });
    const order = data.order || {};
    if (data.status !== 'success' && !order.delivered_item) {
      throw Object.assign(new Error(data.message || 'Bunny order rejected'), { apiData: data, code: 'ORDER_REJECTED' });
    }
    if (order.delivered_item) delivered.push(order.delivered_item);
    if (order.order_code) orderId = order.order_code;
    spent += parseFloat(order.base_price ?? base) || 0;
    if (Number.isFinite(+data.balance)) balanceAfter = parseFloat(data.balance);
  }

  return { deliveries: delivered, order_id: orderId, spent_usd: spent, balance_after: balanceAfter };
}

module.exports = { type: 'bunny', fetchCatalog, getBalance, placeOrder, cleanDescription };
