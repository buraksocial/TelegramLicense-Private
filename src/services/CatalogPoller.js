/**
 * CatalogPoller — background refresher for every enabled supplier.
 *
 * ONE request per supplier per its poll_interval_ms (via CatalogStore which
 * itself respects the RateGovernor), instead of the old per-product polling.
 * Each successful sweep also mirrors price/stock into product_suppliers so
 * menus and the watchdog can read a single joined row.
 */
const { db } = require('../db');
const CatalogStore = require('./CatalogStore');

class CatalogPoller {
  constructor() {
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) clearInterval(this.timer);
    // Tick fast; each supplier decides internally whether it is due.
    this.timer = setInterval(() => this.sweep().catch(() => {}), 5000);
    setTimeout(() => this.sweep().catch(() => {}), 1500);
    console.log('[CatalogPoller] started (5s tick, per-supplier cadence)');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  dueSuppliers() {
    const rows = db.prepare('SELECT * FROM suppliers WHERE enabled = 1').all();
    const now = Date.now();
    const lastRun = CatalogPoller._last || {};
    return rows.filter((s) => {
      const interval = s.poll_interval_ms || 60000;
      return !lastRun[s.id] || now - lastRun[s.id] >= interval;
    });
  }

  async sweep() {
    if (this.running) return;
    this.running = true;
    CatalogPoller._last = CatalogPoller._last || {};
    try {
      for (const supplier of this.dueSuppliers()) {
        CatalogPoller._last[supplier.id] = Date.now();
        try {
          const services = await CatalogStore.getCatalog(supplier, { force: true });
          if (services) {
            this.mirrorLinks(supplier.id, services);
            // Storefront products are curated in migrations/admin tools only;
            // polling refreshes snapshots and existing offer prices/stocks.
            db.prepare('UPDATE suppliers SET last_error = NULL, last_ok_at = ? WHERE id = ?').run(
              new Date().toISOString(), supplier.id
            );
          }
        } catch (err) {
          db.prepare('UPDATE suppliers SET last_error = ? WHERE id = ?').run(
            String(err.message).slice(0, 500), supplier.id
          );
        }
        try {
          await CatalogStore.getBalance(supplier);
        } catch (e) { /* cached/stale value is fine */ }
      }

      // New/changed services -> match suggestions for the approval queue
      // (pending only; the admin stays in the loop). Every 30 min.
      if (!CatalogPoller._lastSuggest || Date.now() - CatalogPoller._lastSuggest > 1800000) {
        CatalogPoller._lastSuggest = Date.now();
        try {
          const { updated } = require('./CatalogMatcher').suggest();
          if (updated) console.log(`[CatalogPoller] match suggestions updated: ${updated}`);
        } catch (e) { console.error('[CatalogPoller] suggest:', e.message); }
      }
    } catch (err) {
      console.error('[CatalogPoller] sweep error:', err.message);
    } finally {
      this.running = false;
    }
  }

  /** Keep product_suppliers.last_price_usd / last_stock in sync. */
  mirrorLinks(supplierId, services) {
    const upd = db.prepare(
      'UPDATE product_suppliers SET last_price_usd = ?, last_stock = ? WHERE supplier_id = ? AND remote_service_id = ?'
    );
    const tx = db.transaction(() => {
      for (const s of services) {
        upd.run(s.price_usd ?? null, s.stock ?? null, supplierId, s.remote_service_id);
      }
    });
    tx();
  }
}

module.exports = new CatalogPoller();
