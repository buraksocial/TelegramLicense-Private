/**
 * CheckoutService — the single source of truth for the buy flow.
 *
 * Both the Telegram handlers (user.js) and the web store (web/server.js)
 * call into this. It owns: pricing (incl. warranty gate + price locks),
 * inventory/auto-restock fulfilment, payment recording (transactions,
 * orders, reservations), referral/rewards side effects.
 *
 * Handlers keep their UX (messages/keyboards); they do not keep logic.
 */
const crypto = require('crypto');
const { db } = require('../db');
const { PricingEngine } = require('../services/PricingEngine');
const SupplierManager = require('../services/SupplierManager');
const { getUsdTryRate } = require('../utils/currency');
const { t } = require('../utils/i18n');
const { classifyWarranty } = require('../utils/warranty');

// ---------------------------------------------------------------- pricing

function getUserLang(userId) {
  const user = db.prepare('SELECT lang FROM users WHERE id = ?').get(userId);
  return user?.lang || 'en';
}

function getUserRank(userId) {
  const user = db.prepare('SELECT total_purchases FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  return db.prepare('SELECT * FROM ranks WHERE min_purchases <= ? ORDER BY min_purchases DESC LIMIT 1').get(user.total_purchases || 0);
}

function getReservationFee(userId) {
  const userRow = db.prepare('SELECT custom_reservation_fee FROM users WHERE id = ?').get(userId);
  if (userRow && userRow.custom_reservation_fee !== null) return parseFloat(userRow.custom_reservation_fee);
  const feeRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('reservation_fee');
  return feeRow ? parseFloat(feeRow.value) : 0.10;
}

function getUserUnitPrice(userId, product, baseUnitOverride = null) {
  const userGroup = db.prepare(
    'SELECT g.id, g.discount_percent FROM user_pricing_groups u JOIN pricing_groups g ON u.group_id = g.id WHERE u.user_id = ?'
  ).get(userId);
  if (userGroup) {
    const groupProduct = db.prepare('SELECT price FROM pricing_group_products WHERE group_id = ? AND product_id = ?').get(userGroup.id, product.id);
    if (groupProduct) return groupProduct.price;
    const base = baseUnitOverride !== null ? baseUnitOverride : product.price;
    if (userGroup.discount_percent > 0) return base * (1 - userGroup.discount_percent / 100);
    return base;
  }

  const rank = getUserRank(userId);
  let price = baseUnitOverride !== null ? baseUnitOverride : product.price;
  if (rank) {
    const rankProduct = db.prepare('SELECT special_price FROM rank_special_prices WHERE rank_id = ? AND product_id = ?').get(rank.id, product.id);
    if (rankProduct) price = rankProduct.special_price;
    else if (rank.discount_percent > 0) price = price * (1 - rank.discount_percent / 100);
  }

  const isActualReseller = db.prepare('SELECT * FROM resellers WHERE user_id = ?').get(userId);
  const userRow = db.prepare('SELECT reseller_promo_ban FROM users WHERE id = ?').get(userId);
  if (!isActualReseller && (!userRow || userRow.reseller_promo_ban === 0)) {
    const activePromo = db.prepare(`
      SELECT p.value FROM promo_codes p
      JOIN user_promos up ON p.id = up.promo_id
      WHERE up.user_id = ? AND p.type = 'discount'
        AND (up.expires_at IS NULL OR up.expires_at > CURRENT_TIMESTAMP)
      ORDER BY p.value DESC LIMIT 1
    `).get(userId);
    if (activePromo && activePromo.value > 0) price = price * (1 - activePromo.value / 100);
  }
  return price;
}

function calculateTotalPrice(userId, product, qty, baseUnitOverride = null) {
  let unitPrice = getUserUnitPrice(userId, product, baseUnitOverride);
  const userGroup = db.prepare('SELECT * FROM user_pricing_groups WHERE user_id = ?').get(userId);
  if (!userGroup) {
    const bestDiscount = db.prepare(
      'SELECT * FROM product_bulk_discounts WHERE product_id = ? AND min_qty <= ? ORDER BY min_qty DESC LIMIT 1'
    ).get(product.id, qty);
    if (bestDiscount) {
      if (bestDiscount.fixed_price !== null && bestDiscount.fixed_price !== undefined) unitPrice = bestDiscount.fixed_price;
      else if (bestDiscount.discount_percent > 0) unitPrice = unitPrice * (1 - bestDiscount.discount_percent / 100);
    }
  }
  return unitPrice * qty;
}

// ---------------------------------------------------------------- locks

function issuePriceLock(product, offer, unitPrice, ttlMs = 600000) {
  const token = crypto.randomBytes(8).toString('hex');
  try {
    db.prepare('DELETE FROM price_locks WHERE expires_at < datetime(\'now\')').run();
    db.prepare(`INSERT INTO price_locks (token, product_id, product_supplier_id, supplier_id, unit_price, expires_at)
                VALUES (?,?,?,?,?,datetime('now', ?))`)
      .run(token, product.id,
        offer ? offer.product_supplier_id : null,
        offer ? offer.supplier_id : null,
        unitPrice,
        `+${Math.round(ttlMs / 1000)} seconds`);
  } catch (e) { /* price_locks table optional at this point */ }
  return token;
}

function readPriceLock(token) {
  if (!token) return null;
  const row = db.prepare("SELECT * FROM price_locks WHERE token = ? AND expires_at > datetime('now')").get(token);
  if (!row) return null;
  return { product_id: row.product_id, unit_price: row.unit_price, psId: row.product_supplier_id };
}

// ---------------------------------------------------------------- offers

/**
 * Full offer decision for a product at a qty (pricing engine + warranty gate).
 * Returns null for manual-mode products (legacy stock-only flow).
 */
async function productDecision(product, qty = 1) {
  const mode = product.pricing_mode || 'manual';
  if (mode === 'manual') return null;
  const { offers } = await PricingEngine.buildOffers(product, { qty });
  const decision = PricingEngine.decide(product, offers);
  decision.warranty = product.warranty || 'none';
  return decision;
}

/** Customer-safe service lines: translated name, price (with discounts), masked stock. */
function serviceLines(product, decision, lang, userId = null) {
  const { TranslationService } = require('../services/TranslationService');
  return decision.all.map((o, i) => {
    const visible = decision.maskedStock.get(o.product_supplier_id);
    let name = String(TranslationService.translate(o.remote_name || o.supplier_name, lang) || o.remote_name || '').slice(0, 42);
    const isBest = decision.priceOffer && o.product_supplier_id === decision.priceOffer.product_supplier_id;
    const sellUnit = userId != null && o.affordable
      ? round2(getUserUnitPrice(userId, product, o.sellUnit))
      : o.sellUnit;
    return {
      index: i + 1,
      psId: o.product_supplier_id,
      supplier_name: o.supplier_name,   // admin-only; NOT sent to customers
      name,
      sellUnit,
      stock: visible,
      affordable: o.affordable,
      reason: o.reason,
      best: !!isBest,
      warranty: o.warranty
    };
  });
}

// ---------------------------------------------------------------- fulfilment

class CheckoutError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * Reserve local stock (returns rows) — used inside delivery transaction.
 */
function takeStockRows(productId, qty) {
  return db.prepare('SELECT * FROM stocks WHERE product_id = ? AND is_sold = 0 LIMIT ?').all(productId, qty);
}

/**
 * Core fulfilment + bookkeeping. `payer` describes how the customer paid.
 *
 * @param userId
 * @param product   products row
 * @param qty
 * @param opts {
 *   paidAmount,            // what was actually paid (USD)
 *   unitBase,              // locked display unit (dynamic) or null
 *   chosenPs,              // product_supplier_id the customer selected (provenance only)
 *   txid,                  // unique payment reference (idempotency)
 *   isReservation,         // true -> create reservation instead of delivery
 *   bidPrice,              // reservation bid unit price (optional)
 *   source,                // 'bot' | 'web'
 *   deliverFn(delivered),  // optional: how to reveal data to the user
 * }
 * @returns result object
 */
async function fulfill(userId, product, qty, opts) {
  const { paidAmount, unitBase = null, chosenPs = null, txid, source = 'bot' } = opts;
  const lang = getUserLang(userId);
  const tryRate = await getUsdTryRate();

  // ---- reservation (no immediate delivery) ----
  if (opts.isReservation) {
    const reservationFee = getReservationFee(userId);
    const tm = opts.trueMissing !== undefined ? opts.trueMissing : qty;
    const totalFee = tm * reservationFee;
    const baseUnitPrice = calculateTotalPrice(userId, product, 1, unitBase) * 1.10;
    const reserveUnitPrice = opts.bidPrice ? opts.bidPrice : baseUnitPrice + (qty > 0 ? totalFee / qty : 0);
    const costUsd = product.cost_usd || 0;
    const profitUsd = paidAmount - costUsd * qty;

    db.prepare(`INSERT INTO reservations (user_id, product_id, qty, fulfilled_qty, cost_usd, sell_usd, profit_usd, cost_try, sell_try, profit_try, unit_price, status)
                VALUES (?,?,?,?,?,?,?,?,?,?,?, 'PENDING')`)
      .run(userId, product.id, qty, 0, costUsd, paidAmount, profitUsd,
        costUsd * qty * tryRate, paidAmount * tryRate, profitUsd * tryRate, reserveUnitPrice);
    db.prepare('INSERT INTO transactions (txid, user_id, product_id, amount, status, amount_try) VALUES (?,?,?,?,?,?)')
      .run(txid, userId, product.id, paidAmount, 'SUCCESS', paidAmount * tryRate);
    db.prepare('INSERT INTO orders (user_id, product_id, qty, cost_usd, sell_usd, profit_usd, cost_try, sell_try, profit_try) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(userId, product.id, qty, costUsd, paidAmount, profitUsd,
        costUsd * qty * tryRate, paidAmount * tryRate, profitUsd * tryRate);
    db.prepare('UPDATE users SET total_purchases = total_purchases + ? WHERE id = ?').run(qty, userId);
    return { kind: 'reservation', qty, reserveUnitPrice };
  }

  // ---- ensure stock: local + restock/dynamic-direct ----
  let localStockCount = db.prepare('SELECT COUNT(*) c FROM stocks WHERE product_id = ? AND is_sold = 0').get(product.id).c;
  let supplierProvenance = null;
  const threshold = product.auto_restock_threshold || 0;
  const dynamicDirect = ((product.pricing_mode || 'manual') !== 'manual' || chosenPs) && qty > localStockCount;
  const needed = Math.max(0, qty - localStockCount);

  if ((localStockCount - qty <= threshold && product.auto_restock_enabled) || dynamicDirect) {
    const buyQty = dynamicDirect && needed > 0 ? needed : Math.max(product.auto_restock_qty || 1, needed);
    try {
      const orderResult = await SupplierManager.placeOrder(product, buyQty, {
        sellPriceUnit: paidAmount / Math.max(1, qty),
        idempotency_key: `${txid}_${product.id}_${buyQty}`
      });
      const apiResponse = orderResult.result;
      supplierProvenance = {
        supplier_id: orderResult.supplier_id || null,
        remote_service_id: orderResult.remote_service_id || null,
        external_order_id: apiResponse.external_order_id || null,
        margin_pct: apiResponse.margin_pct != null ? apiResponse.margin_pct : null,
        api_unit_cost: buyQty > 0 && apiResponse.cost_usd != null ? apiResponse.cost_usd / buyQty : null
      };
      if (apiResponse && apiResponse.products && apiResponse.products.length) {
        const ins = db.prepare('INSERT INTO stocks (product_id, data, is_sold) VALUES (?, ?, 0)');
        db.transaction((prods) => { for (const p of prods) ins.run(product.id, p); })(apiResponse.products);
        localStockCount += apiResponse.products.length;
      }
    } catch (err) {
      if (needed > 0) {
        if (err.message === 'OUT_OF_STOCK_OR_BALANCE' || err.name === 'AllSuppliersFailedError') {
          throw new CheckoutError('not_enough_stock', `Yetersiz stok: en fazla ${Math.max(0, localStockCount)} adet teslim edilebilir.`);
        }
        throw new CheckoutError('restock_failed', 'Stok tedarik edilirken API hatası. Ödemeniz güvendedir, yönetici bilgilendirildi.');
      }
    }
  }

  // ---- deliver ----
  const deliver = db.transaction(() => {
    const stocks = takeStockRows(product.id, qty);
    if (stocks.length < qty) throw new CheckoutError('OUT_OF_STOCK', 'Yetersiz stok.');
    const data = [];
    for (const s of stocks) {
      db.prepare('UPDATE stocks SET is_sold = 1 WHERE id = ?').run(s.id);
      data.push(s.data);
    }
    db.prepare('INSERT INTO transactions (txid, user_id, product_id, amount, status, amount_try) VALUES (?,?,?,?,?,?)')
      .run(txid, userId, product.id, paidAmount, 'SUCCESS', paidAmount * tryRate);
    return data;
  });

  let deliveredData;
  try { deliveredData = deliver(); }
  catch (e) {
    if (e instanceof CheckoutError) throw e;
    throw new CheckoutError('OUT_OF_STOCK', 'Yetersiz stok.');
  }

  const costUsd = supplierProvenance && supplierProvenance.api_unit_cost != null
    ? supplierProvenance.api_unit_cost : (product.cost_usd || 0);
  const profitUsd = paidAmount - costUsd * qty;
  db.prepare(`INSERT INTO orders (user_id, product_id, qty, cost_usd, sell_usd, profit_usd, cost_try, sell_try, profit_try, delivered_data,
      supplier_id, remote_service_id, cost_usd_at_purchase, margin_pct_at_purchase, external_order_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(userId, product.id, qty, costUsd, paidAmount, profitUsd,
      costUsd * qty * tryRate, paidAmount * tryRate, profitUsd * tryRate,
      JSON.stringify(deliveredData),
      supplierProvenance ? supplierProvenance.supplier_id : null,
      supplierProvenance ? supplierProvenance.remote_service_id : null,
      supplierProvenance && supplierProvenance.api_unit_cost != null ? supplierProvenance.api_unit_cost : (product.cost_usd || 0),
      supplierProvenance ? supplierProvenance.margin_pct : null,
      supplierProvenance ? supplierProvenance.external_order_id : null);

  db.prepare('UPDATE users SET total_purchases = total_purchases + ? WHERE id = ?').run(qty, userId);

  // referral reward (same rules as the bot flow)
  applyReferralReward(userId, product, paidAmount, qty);

  return {
    kind: 'delivered',
    qty,
    delivered: deliveredData,
    orderProvenance: supplierProvenance,
    cost_usd: costUsd,
    sell_usd: paidAmount,
    profit_usd: profitUsd
  };
}

function applyReferralReward(userId, product, paidAmount, qty) {
  const buyerUser = db.prepare('SELECT referred_by FROM users WHERE id = ?').get(userId);
  if (!buyerUser || !buyerUser.referred_by) return;
  const referrerIsReseller = db.prepare('SELECT * FROM reseller_users WHERE user_id = ?').get(buyerUser.referred_by);
  if (referrerIsReseller) return;
  const usedPromo = db.prepare(`
    SELECT p.id FROM promo_codes p JOIN user_promos up ON p.id = up.promo_id
    WHERE up.user_id = ? AND p.type='discount' AND (up.expires_at IS NULL OR up.expires_at > CURRENT_TIMESTAMP)
  `).get(userId);
  if (usedPromo) return;

  const refEnabled = db.prepare("SELECT value FROM settings WHERE key='referral_enabled'").get();
  if (!refEnabled || refEnabled.value !== '1') return;
  const refType = db.prepare("SELECT value FROM settings WHERE key='referral_reward_type'").get();
  const refValueStr = db.prepare("SELECT value FROM settings WHERE key='referral_reward_value'").get();
  const refVal = parseFloat(refValueStr ? refValueStr.value : '0');
  if (!(refVal > 0)) return;
  let reward = 0;
  if (refType && refType.value === 'percent') reward = paidAmount * (refVal / 100);
  else reward = refVal * qty;
  if (reward > 0) {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(reward, buyerUser.referred_by);
    try {
      const { sendWalletTopUpLog } = require('../utils/logger');
      const bot = global.__LICENSE_BOT; // set by bot.js; avoids circular require
      if (bot && bot.telegram) sendWalletTopUpLog(bot.telegram, buyerUser.referred_by, reward);
    } catch (e) { /* logger needs a live bot; skippable for web orders */ }
  }
}

// ---------------------------------------------------------------- cart/pricing summary for listing

/**
 * Summary row for a product in a menu (bot or web): price + stock + sold-out.
 */
async function productSummary(userId, product) {
  const lang = getUserLang(userId);
  const stockCount = db.prepare('SELECT COUNT(*) c FROM stocks WHERE product_id = ? AND is_sold = 0').get(product.id).c;
  const mode = product.pricing_mode || 'manual';

  if (mode === 'manual') {
    const unit = getUserUnitPrice(userId, product);
    return {
      mode: 'manual', unit: round2(unit), stock: stockCount,
      soldOut: stockCount === 0, reserve: stockCount === 0, lang,
      name: localized(product, lang)
    };
  }

  const decision = await productDecision(product, 1);
  if (!decision) {
    const unit = getUserUnitPrice(userId, product);
    return { mode: 'manual', unit: round2(unit), stock: stockCount, soldOut: stockCount === 0, reserve: stockCount === 0, lang, name: localized(product, lang) };
  }
  const base = decision.soldOut || decision.displayUnit === null ? (product.price || 0) : decision.displayUnit;
  // customer-specific discounts (rank/group/promo/bulk base) apply on top of
  // the dynamic base, same as at checkout.
  const unit = round2(getUserUnitPrice(userId, product, base));
  return {
    mode,
    unit,
    stock: stockCount + (decision.soldOut ? 0 : decision.affordable.reduce((a, o) => a + (o.realStock || 0), 0)),
    soldOut: decision.soldOut,
    reserve: false,
    lang,
    name: localized(product, lang),
    warranty: product.warranty || 'none',
    decision
  };
}

function localized(product, lang) {
  try { const j = JSON.parse(product.name); return j[lang] || j.en || j.tr || product.name; }
  catch (e) { return product.name; }
}
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// ---------------------------------------------------------------- promo
// Shared by the bot's /promo command and the web store's promo box.
// Returns { ok, message } — message is customer-facing.
function redeemPromo(userId, codeStr) {
  const { sendWalletTopUpLog } = require('../utils/logger');
  const telegram = global.__LICENSE_BOT ? global.__LICENSE_BOT.telegram : null;

  const isActualReseller = db.prepare('SELECT * FROM resellers WHERE user_id = ?').get(userId);
  if (isActualReseller) return { ok: false, message: '❌ Bayiler promosyon kodu kullanamazlar.' };

  const userRow = db.prepare('SELECT reseller_promo_ban FROM users WHERE id = ?').get(userId);
  if (userRow && userRow.reseller_promo_ban === 1) {
    return { ok: false, message: '❌ Promosyon kodu kullanamazsınız. Bayiden gelen bakiyenizi henüz tüketmediniz.' };
  }

  const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ? COLLATE NOCASE').get(String(codeStr || '').trim());
  if (!promo) return { ok: false, message: '❌ Geçersiz promo kodu.' };
  if (promo.expires_at && new Date(promo.expires_at + 'Z') < new Date()) return { ok: false, message: '❌ Bu kodun süresi dolmuş.' };

  const used = db.prepare('SELECT * FROM user_promos WHERE user_id = ? AND promo_id = ?').get(userId, promo.id);
  if (used) return { ok: false, message: '❌ Bu kodu zaten kullandınız.' };

  const usageCount = db.prepare('SELECT COUNT(*) as c FROM user_promos WHERE promo_id = ?').get(promo.id).c;
  if (usageCount >= promo.max_uses) return { ok: false, message: '❌ Bu kodun kullanım sınırı dolmuş.' };

  const expiresAt = promo.expiry_hours ? new Date(Date.now() + promo.expiry_hours * 3600000).toISOString() : null;

  if (promo.type === 'balance') {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(promo.value, userId);
    db.prepare('INSERT INTO user_promos (user_id, promo_id, expires_at) VALUES (?, ?, ?)').run(userId, promo.id, expiresAt);
    if (telegram) sendWalletTopUpLog(telegram, userId, promo.value);
    return { ok: true, message: `✅ Tebrikler! Hesabınıza ${promo.value}$ bakiye eklendi.`, balance_added: promo.value };
  }
  db.prepare('INSERT INTO user_promos (user_id, promo_id, expires_at) VALUES (?, ?, ?)').run(userId, promo.id, expiresAt);
  const timeTxt = promo.expiry_hours ? `${promo.expiry_hours} saat boyunca ` : '';
  return { ok: true, message: `✅ Tebrikler! ${timeTxt}%${promo.value} indirim kazandınız!`, discount_percent: promo.value };
}

module.exports = {
  getUserLang, getUserRank, getReservationFee, getUserUnitPrice, calculateTotalPrice,
  issuePriceLock, readPriceLock, redeemPromo,
  productDecision, serviceLines,
  fulfill, productSummary, localized,
  CheckoutError, classifyWarranty
};
