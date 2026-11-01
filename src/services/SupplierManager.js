/**
 * SupplierManager v2 — thin orchestration on top of PricingEngine + adapters.
 *
 * Keeps the historical static API (getAffordableQuantity / placeOrder) so
 * ReservationManager and the checkout flow keep working, but every call now
 * goes through the governor-protected adapter layer instead of the old
 * per-product getPrice polling.
 *
 * Fulfilment guarantee (operator decision): once the customer has paid we
 * NEVER refund-block them. We try the fulfilment offer chosen by the pricing
 * engine; on any supplier-side failure (stock vanished, buffer error,
 * insufficient balance discovered live) we walk the remaining affordable
 * offers cheapest-first and only then give up. The customer price is locked,
 * so a worse source just shrinks our margin — MarginWatchdog logs that.
 */
const { db } = require('../db');
const { PricingEngine } = require('./PricingEngine');
const CatalogStore = require('./CatalogStore');
const registry = require('./adapterRegistry');
const crypto = require('crypto');

class AllSuppliersFailedError extends Error {
  constructor(message, attempts = []) {
    super(message);
    this.name = 'AllSuppliersFailedError';
    this.attempts = attempts;
  }
}

function newIdempotencyKey(product, qty) {
  return `lp_${product.id}_${qty}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

class SupplierManager {
  /** Back-compatible shim used by old callers that pass a raw joined row. */
  static normalizeProduct(product) {
    return product;
  }

  /** How many units can actually be delivered right now across all suppliers. */
  static async getAffordableQuantity(product, neededQty) {
    return PricingEngine.affordableQuantity(product, neededQty);
  }

  /**
   * @param product  products row (pricing_mode, supplier_selection_mode...)
   * @param quantity number
   * @param opts     { sellPriceUnit, priceOfferId, marginFloorPct }
   * @returns {Promise<{supplier_id, result:{success, products[], cost_usd,
   *                            order_id, external_order_id, balance_after,
   *                            margin_pct, attempts[]}}>}
   */
  static async placeOrder(product, quantity, opts = {}) {
    // Always decide on a FRESH catalog read (force refresh if governor allows).
    const { offers } = await PricingEngine.buildOffers(product, { qty: quantity });
    const decision = PricingEngine.decide(product, offers);

    // Fulfilment order: chosen fulfilment offer first, then remaining
    // affordable offers cheapest-first as fallback.
    const queue = [];
    if (opts.fulfillPsId) {
      const chosen = offers.find((o) => o.product_supplier_id === opts.fulfillPsId && o.affordable);
      if (chosen) queue.push(chosen);
    }
    if (decision.fulfillOffer && !queue.includes(decision.fulfillOffer)) queue.push(decision.fulfillOffer);
    for (const o of [...decision.affordable].sort((a, b) => a.cost - b.cost)) {
      if (!queue.includes(o)) queue.push(o);
    }

    if (!queue.length) {
      throw Object.assign(new Error('OUT_OF_STOCK_OR_BALANCE'), {
        reason: 'no_affordable_offer'
      });
    }

    const idemKey = opts.idempotency_key || newIdempotencyKey(product, quantity);
    const attempts = [];

    for (const offer of queue) {
      const adapter = registry.forSupplier(offer.supplier);
      if (!adapter) {
        attempts.push({ supplier_id: offer.supplier_id, error: 'no_adapter' });
        continue;
      }
      try {
        const res = await adapter.placeOrder(offer.supplier, {
          remote_service_id: offer.remote_service_id,
          quantity,
          selling_price_usd: opts.sellPriceUnit,
          idempotency_key: idemKey
        });

        const deliveries = Array.isArray(res.deliveries) ? res.deliveries : [];
        if (!deliveries.length && !res.dry_run) {
          throw Object.assign(new Error('empty delivery'), { code: 'EMPTY' });
        }

        const spent = res.spent_usd !== null && res.spent_usd !== undefined ? res.spent_usd : offer.cost;
        const marginPct = spent > 0 && opts.sellPriceUnit
          ? Math.round(((opts.sellPriceUnit * quantity - spent) / spent) * 1000) / 10
          : offer.marginPct;

        CatalogStore.invalidateBalance(offer.supplier_id);

        return {
          supplier_id: offer.supplier_id,
          remote_service_id: offer.remote_service_id,
          result: {
            success: true,
            products: deliveries,
            cost_usd: spent,
            order_id: res.order_id || null,
            external_order_id: idemKey,
            balance_after: res.balance_after ?? null,
            margin_pct: marginPct,
            dry_run: !!res.dry_run,
            attempts
          }
        };
      } catch (err) {
        attempts.push({
          supplier_id: offer.supplier_id,
          type: offer.supplier.type,
          error: String(err.apiMessage || err.message).slice(0, 300),
          code: err.code || null
        });
        console.error(
          `[SupplierManager] supplier ${offer.supplier.type}#${offer.supplier_id} failed for product ${product.id}:`,
          err.message
        );
        // A vanished service should not be re-offered from stale catalog.
        if (/not_found|gone|unavailable|stock|balance|buffer|rejected/i.test(`${err.code || ''} ${err.message || ''}`)) {
          CatalogStore.invalidateCatalog(offer.supplier_id);
        }
      }
    }

    // Everything failed: surface a structured error with per-supplier reasons
    // so the caller can decide (reservation fallback / admin alert).
    throw new AllSuppliersFailedError(
      `All ${attempts.length} supplier attempt(s) failed for product ${product.id} x${quantity}`,
      attempts
    );
  }

  /** Legacy-compat: admin panels still call this to list raw supplier rows. */
  static listSuppliers() {
    return db.prepare('SELECT * FROM suppliers ORDER BY id').all();
  }
}

module.exports = SupplierManager;
module.exports.AllSuppliersFailedError = AllSuppliersFailedError;
