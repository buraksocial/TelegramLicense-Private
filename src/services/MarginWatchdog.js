/**
 * MarginWatchdog — periodic margin/balance auditor with admin alerts.
 *
 * Every pass (default 5 min) it re-prices active products through the
 * PricingEngine (snapshot-only, no extra API load) and warns the admin when:
 *   - we would fulfil from a supplier whose margin is lower than the best
 *     available (operator asked for exactly this message);
 *   - a previously sold-out product got restocked / balance freed;
 *   - a supplier wallet drops under the configured warning line.
 * One alert per (product, kind) per MARGIN_ALERT_COOLDOWN_MS.
 */
const { db } = require('../db');
const { PricingEngine } = require('./PricingEngine');
const CatalogStore = require('./CatalogStore');
const { ADMIN_ID } = require('../config/env');
const { MARGIN_ALERT_COOLDOWN_MS } = require('../constants');

const BALANCE_WARN_USD = parseFloat(process.env.BALANCE_WARN_USD || '1');

class MarginWatchdog {
  constructor() {
    this.timer = null;
    this.bot = null;
    this.lastAlerts = new Map(); // `${productId}:${kind}` -> timestamp
    this.lastState = new Map(); // productId -> { soldOut, fulfillId }
    this.lastBalanceWarn = new Map();
  }

  start(bot, intervalMs = 300000) {
    this.bot = bot;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.pass().catch((e) => console.error('[Watchdog]', e.message)), intervalMs);
    setTimeout(() => this.pass().catch(() => {}), 20000);
    console.log(`[MarginWatchdog] started (every ${intervalMs / 1000}s)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  alertAllowed(key) {
    const last = this.lastAlerts.get(key) || 0;
    if (Date.now() - last < MARGIN_ALERT_COOLDOWN_MS) return false;
    this.lastAlerts.set(key, Date.now());
    return true;
  }

  async notify(text) {
    if (!this.bot || !ADMIN_ID) return;
    try {
      await this.bot.telegram.sendMessage(ADMIN_ID, text, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('[MarginWatchdog] admin notify failed:', e.message);
    }
  }

  async pass() {
    const products = db.prepare('SELECT * FROM products WHERE is_active = 1').all();
    const lowMargin = [];
    for (const product of products) {
      try {
        const info = await this.checkProduct(product);
        if (info) lowMargin.push(info);
      } catch (err) {
        console.error(`[MarginWatchdog] product ${product.id}: ${err.message}`);
      }
    }

    // Aggregated operator message: "X kadar servis daha düşük kâr ediliyor"
    if (lowMargin.length && this.alertAllowed('summary:low_margin')) {
      const lines = lowMargin.slice(0, 8).map((l) =>
        `• ${l.name} — ${l.priceName} %${l.bestMargin} yerine ${l.fulfillName} %${l.servedMargin} (fark $${Number(l.diff) >= 0 ? '+' : ''}${l.diff}/adet)`);
      await this.notify(
        `📊 <b>${lowMargin.length} kadar servis daha düşük kâr ediliyor</b>\n` +
        `Fiyat en kârlı teklife göre belirleniyor, teslim diğer kaynaktan yapılıyor. ` +
        `Eksi fark kasaya ek kâr yazar; artı fark teslimi pahalı kaynaktan aldırdığını gösterir.\n` +
        lines.join('\n') +
        (lowMargin.length > 8 ? `\n… ve ${lowMargin.length - 8} servis daha` : '') +
        '\n<i>İstersen bu ürünlerin fiyatını ya da teslim sırasını güncelleyebilirsin.</i>'
      );
    }

    await this.checkBalances();
  }

  async checkProduct(product) {
    const { offers } = await PricingEngine.buildOffers(product, { qty: 1 });
    if (!offers.length) return null;
    const decision = PricingEngine.decide(product, offers);
    const prev = this.lastState.get(product.id);

    const name = (() => {
      try { return JSON.parse(product.name).en || product.name; } catch (e) { return product.name; }
    })();

    let lowMarginInfo = null;

    // --- low-margin fulfilment detection -----------------------------------
    if (decision.fulfillOffer && decision.priceOffer &&
        decision.fulfillOffer.product_supplier_id !== decision.priceOffer.product_supplier_id) {
      const servedMargin = decision.fulfillOffer.marginPct;
      const bestMargin = decision.priceOffer.marginPct;
      if (servedMargin < bestMargin) {
        if (this.alertAllowed(`${product.id}:low_margin`)) {
          db.prepare(
            `INSERT INTO margin_events (product_id, kind, best_margin_pct, served_margin_pct, best_supplier_id, served_supplier_id, reason)
             VALUES (?, 'low_margin', ?, ?, ?, ?, ?)`
          ).run(
            product.id, bestMargin, servedMargin,
            decision.priceOffer.supplier_id, decision.fulfillOffer.supplier_id,
            `price=${decision.displayUnit} cost=${decision.fulfillOffer.unitCost}`
          );
        }
        lowMarginInfo = {
          name,
          priceName: decision.priceOffer.supplier_name,
          fulfillName: decision.fulfillOffer.supplier_name,
          bestMargin,
          servedMargin,
          // positive = fulfilment source is MORE expensive than the priced one
          diff: (decision.fulfillOffer.unitCost - decision.priceOffer.unitCost).toFixed(2)
        };
      }
    }

    // --- back-in-stock alert ---------------------------------------------
    if (prev && prev.soldOut && !decision.soldOut && this.alertAllowed(`${product.id}:restocked`)) {
      db.prepare(
        `INSERT INTO margin_events (product_id, kind, served_supplier_id, reason) VALUES (?, 'restocked', ?, ?)`
      ).run(product.id, decision.fulfillOffer?.supplier_id || null, 'offers available again');
      await this.notify(`📦 <b>Yeniden stokta:</b> ${name} — artık ${decision.affordable.length} tedarikçiden teslim edilebilir.`);
    }

    this.lastState.set(product.id, {
      soldOut: decision.soldOut,
      fulfillId: decision.fulfillOffer?.product_supplier_id || null
    });

    return lowMarginInfo;
  }

  async checkBalances() {
    const suppliers = db.prepare('SELECT * FROM suppliers WHERE enabled = 1 AND type != ?').all('aixshopbot');
    for (const supplier of suppliers) {
      try {
        const balance = await CatalogStore.getBalance(supplier);
        if (balance === null) continue;
        const key = `bal:${supplier.id}`;
        const warned = this.lastBalanceWarn.get(supplier.id) || 0;
        if (balance < BALANCE_WARN_USD && Date.now() - warned > MARGIN_ALERT_COOLDOWN_MS * 2) {
          this.lastBalanceWarn.set(supplier.id, Date.now());
          if (this.alertAllowed(key)) {
            db.prepare('INSERT INTO alerts (kind, supplier_id, payload) VALUES (?, ?, ?)').run(
              'balance_low', supplier.id, String(balance)
            );
            await this.notify(
              `💸 <b>Bakiye düşük:</b> ${supplier.name} — $${balance.toFixed(4)}\n` +
              `Ürünler "tükendi" rozetiyle görünüyor; doldurunca otomatik açılacak.`
            );
          }
        }
      } catch (e) { /* governor/stale tolerated */ }
    }
  }
}

module.exports = new MarginWatchdog();
