/**
 * PricingEngine — the single source of truth for "what does the customer see
 * and who do we actually buy from".
 *
 * Concepts:
 *  - An OFFER = one product_suppliers row resolved against the live catalog
 *    snapshot of that supplier (no network here; CatalogStore owns fetching).
 *  - sellPrice(offer) = max(cost * (1 + margin/100), floor). Floor implements
 *    "I buy at 0.60 but I still want to sell at $3, not $1.50".
 *  - pricing_mode decides the CUSTOMER price:
 *      max_profit -> the most profitable affordable offer's sell price
 *      cheapest   -> the lowest affordable sell price
 *      manual     -> products.price (offers only used for fulfilment)
 *  - fulfillment_mode decides WHO WE ACTUALLY BUY FROM (independent axis):
 *      cheapest   -> lowest cost among affordable offers (user's rule: even
 *                    though the customer paid the max_profit price, we source
 *                    from the 0.60 API and keep the extra margin)
 *      priority   -> lowest priority number
 *      optimal    -> knapsack split across suppliers (bulk orders)
 *  - Affordability: balance >= cost*qty AND stock >= qty AND supplier enabled
 *    AND link enabled AND stock above supplier's min_stock_buffer.
 *  - Stock masking: when we fulfil from a cheaper offer than the one that set
 *    the displayed price, the fulfilment source's stock is shown LOWER than
 *    the price-setting offer's stock (jittered) so the concentration on one
 *    supplier isn't obvious. 2 -> 1, 10 -> 7-8, etc.
 */
const { db } = require('../db');
const CatalogStore = require('./CatalogStore');
const { effectiveWarranty, warrantyAllows } = require('../utils/warranty');

function parseTiers(raw) {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length) {
      return arr.map((t) => ({
        min: parseInt(t.min, 10) || 1,
        max: t.max === null || t.max === undefined ? Infinity : parseInt(t.max, 10),
        price: parseFloat(t.price)
      }));
    }
  } catch (e) {
    /* fall through */
  }
  return null;
}

function tierPrice(tiers, qty) {
  if (!tiers || !tiers.length) return null;
  for (const t of tiers) {
    if (qty >= t.min && qty <= t.max) return t.price;
  }
  return tiers[tiers.length - 1].price;
}

/** Deterministic-ish but per-call jittered masked stock. */
function maskedStock(realStock, priceOfferStock) {
  if (realStock === null || realStock === undefined) return realStock;
  let masked;
  if (realStock <= 2) masked = Math.max(1, realStock - 1);
  else if (realStock <= 5) masked = Math.max(2, realStock - 1 - Math.floor(Math.random() * 1));
  else masked = Math.floor(realStock * (0.7 + Math.random() * 0.1)); // 10 -> 7..8
  if (priceOfferStock !== null && priceOfferStock !== undefined) {
    masked = Math.min(masked, Math.max(0, priceOfferStock - 1));
  }
  return Math.max(1, masked);
}

class PricingEngine {
  /**
   * Build the offer list for a product from local DB + catalog snapshots.
   * @returns {Promise<{offers: Array, balances: Map, anyCatalog: boolean}>}
   */
  static async buildOffers(product, { qty = 1 } = {}) {
    const links = db
      .prepare(
        `SELECT ps.*, s.id AS supplier_row_id, s.name AS supplier_name, s.type, s.base_url,
                s.api_key, s.enabled AS supplier_enabled, s.currency, s.usd_rate,
                s.min_stock_buffer, s.price_protected, s.delivery_mode
         FROM product_suppliers ps
         JOIN suppliers s ON ps.supplier_id = s.id
         WHERE ps.product_id = ?
         ORDER BY ps.priority ASC`
      )
      .all(product.id);

    const offers = [];
    const balances = new Map();
    let anyCatalog = false;

    for (const link of links) {
      if (!link.supplier_enabled || !link.enabled) continue;
      const supplier = {
        id: link.supplier_row_id,
        name: link.supplier_name,
        type: link.type,
        base_url: link.base_url,
        api_key: link.api_key,
        min_stock_buffer: link.min_stock_buffer || 0
      };

      const catalog = await CatalogStore.getCatalog(supplier).catch(() => null);
      let remote = null;
      if (catalog && catalog.length) {
        anyCatalog = true;
        remote = catalog.find((c) => c.remote_service_id === String(link.remote_service_id)) || null;
      }
      if (!remote) {
        // Catalogless (AixShopBot) or service vanished: fall back to manual tiers / last price.
        const manual = parseTiers(link.manual_tiers);
        if (!manual && link.last_price_usd === null) continue; // nothing to price from
        remote = {
          remote_service_id: String(link.remote_service_id),
          name: link.note || product.name,
          price_usd: link.last_price_usd ?? (manual ? manual[0].price : 0),
          stock: link.last_stock ?? null,
          warranty: 'unknown',
          tiers: manual || [{ min: 1, max: Infinity, price: link.last_price_usd ?? 0 }]
        };
      }

      // Warranty class of THIS offer: admin link override wins, else catalog row.
      const offerWarranty = effectiveWarranty(link.warranty, remote.warranty);

      const effectiveTiers = parseTiers(link.manual_tiers) || remote.tiers || [{ min: 1, max: Infinity, price: remote.price_usd }];
      const unitCost = tierPrice(effectiveTiers, qty) ?? remote.price_usd;
      const cost = unitCost * qty;
      const realStock = remote.stock;

      const balance = await CatalogStore.getBalance(supplier);
      balances.set(supplier.id, balance);

      const margin = link.margin_percent !== null && link.margin_percent !== undefined ? link.margin_percent : product.default_margin_percent ?? 150;
      const floor = link.floor_price !== null && link.floor_price !== undefined ? link.floor_price : product.default_floor_price ?? 0;

      const sellUnit = Math.max(unitCost * (1 + margin / 100), floor || 0);
      const marginPct = unitCost > 0 ? ((sellUnit - unitCost) / unitCost) * 100 : 0;

      let reason = null;
      // Warranty gate: a guaranteed product must not be priced/served by an
      // instant offer, and vice-versa (see utils/warranty for the matrix).
      if (!warrantyAllows(product.warranty, offerWarranty)) {
        reason = 'warranty_mismatch';
      } else if (balance === null) reason = 'no_balance';
      else if (balance < cost) reason = 'insufficient_balance';
      else if (realStock !== null && realStock <= (supplier.min_stock_buffer || 0)) reason = 'below_buffer';
      else if (realStock !== null && realStock < qty) reason = 'out_of_stock';

      offers.push({
        product_supplier_id: link.id,
        supplier,
        supplier_id: supplier.id,
        supplier_name: supplier.name,
        remote_service_id: remote.remote_service_id,
        remote_name: remote.name,
        unitCost,
        cost,
        tiers: effectiveTiers,
        realStock,
        balance,
        margin,
        floor,
        warranty: offerWarranty,
        sellUnit: round2(sellUnit),
        marginPct: Math.round(marginPct * 10) / 10,
        priority: link.priority,
        price_protected: !!supplier.price_protected,
        delivery_mode: supplier.delivery_mode || 'instant',
        affordable: reason === null,
        reservationOnly: reason === 'no_balance' || reason === 'insufficient_balance',
        reason
      });
    }

    return { offers, balances, anyCatalog };
  }

  /**
   * The headline the customer sees + which offer sets it + which offer fulfils.
   */
  static decide(product, offers) {
    const affordable = offers.filter((o) => o.affordable);
    // A service with stock but without supplier balance remains orderable as a
    // reservation. Keep its margin/floor price visible instead of hiding it.
    const reservable = offers.filter((o) =>
      (o.reservationOnly || o.affordable) &&
      o.reason !== 'warranty_mismatch' &&
      (o.realStock === null || o.realStock === undefined || o.realStock >= 1)
    );
    const mode = product.pricing_mode || 'max_profit';
    const fmode = product.supplier_selection_mode || 'cheapest';

    let priceOffer = null;
    if (affordable.length || reservable.length) {
      // Price from every in-stock offer, even when one supplier currently has
      // no balance. Fulfilment still uses `affordable` only. This prevents a
      // temporary supplier balance problem from selecting an unusually costly
      // supplier and inflating the customer price.
      const candidates = reservable.length ? reservable : affordable;
      if (mode === 'manual') priceOffer = null;
      else if (mode === 'cheapest') {
        priceOffer = [...candidates].sort((a, b) => a.sellUnit - b.sellUnit || b.marginPct - a.marginPct)[0];
      } else {
        // max_profit: highest sellUnit; tie -> higher marginPct; tie -> cheaper cost
        priceOffer = [...candidates].sort(
          (a, b) => b.sellUnit - a.sellUnit || b.marginPct - a.marginPct || a.cost - b.cost
        )[0];
      }
    }

    // Fulfilment source (independent of the displayed price).
    let fulfillOffer = null;
    if (affordable.length) {
      if (fmode === 'priority') fulfillOffer = [...affordable].sort((a, b) => a.priority - b.priority)[0];
      else fulfillOffer = [...affordable].sort((a, b) => a.cost - b.cost || a.priority - b.priority)[0]; // cheapest
    }

    const displayUnit = mode === 'manual' ? round2(product.price) : priceOffer ? priceOffer.sellUnit : null;
    const reservationOnly = affordable.length === 0 && reservable.length > 0;
    const soldOut = affordable.length === 0 && reservable.length === 0;

    // Stock masking: if we fulfil from a cheaper source than the price-setter,
    // show the source's stock BELOW the price-setter's so it isn't obvious.
    const masked = new Map();
    for (const o of offers) {
      if (o.realStock === null) {
        masked.set(o.product_supplier_id, null);
        continue;
      }
      const isConcentratedSource = fulfillOffer && priceOffer && o.product_supplier_id === fulfillOffer.product_supplier_id && fulfillOffer !== priceOffer;
      if (isConcentratedSource) {
        masked.set(o.product_supplier_id, maskedStock(o.realStock, priceOffer.realStock));
      } else {
        masked.set(o.product_supplier_id, o.realStock);
      }
    }

    return {
      mode,
      fulfillment_mode: fmode,
      displayUnit,
      soldOut,
      reservationOnly,
      priceOffer,
      fulfillOffer,
      affordable,
      reservable,
      all: offers,
      maskedStock: masked
    };
  }

  /** Full decision for a product at a given qty (async: reads catalog+balance). */
  static async price(product, { qty = 1 } = {}) {
    const { offers, balances, anyCatalog } = await this.buildOffers(product, { qty });
    const decision = this.decide(product, offers);
    return { ...decision, offers, balances, anyCatalog, qty };
  }

  /** How many units can we actually deliver right now (for reservation/qty caps). */
  static async affordableQuantity(product, neededQty) {
    const { offers } = await this.buildOffers(product, { qty: Math.max(1, neededQty) });
    let max = 0;
    for (const o of offers) {
      if (!o.affordable) continue;
      // find the largest qty <= neededQty this offer can afford (tier + balance + stock)
      for (let q = Math.min(neededQty, o.realStock ?? neededQty); q >= 1; q--) {
        const unit = tierPrice(o.tiers, q) ?? o.unitCost;
        if (unit * q <= (o.balance ?? Infinity)) {
          max = Math.max(max, q);
          break;
        }
      }
    }
    return max;
  }
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = { PricingEngine, parseTiers, tierPrice, maskedStock, round2 };
