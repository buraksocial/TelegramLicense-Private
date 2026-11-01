#!/usr/bin/env node
/**
 * Read-only smoke test for the supplier layer. NEVER places orders.
 *   node scripts/smoke_suppliers.js            -> all suppliers
 *   node scripts/smoke_suppliers.js aivault    -> one supplier by type
 */
require('dns').setDefaultResultOrder('ipv4first');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'database.sqlite');
const db = new Database(dbPath, { readonly: true });

const filter = process.argv[2];
const suppliers = db
  .prepare('SELECT * FROM suppliers WHERE enabled = 1' + (filter ? ' AND type = ?' : ''))
  .all(...(filter ? [filter] : []));

if (!suppliers.length) {
  console.error('No suppliers found (run migrations first).');
  process.exit(1);
}

(async () => {
  const CatalogStore = require('../src/services/CatalogStore');
  for (const s of suppliers) {
    const t0 = Date.now();
    try {
      const [balance, catalog] = await Promise.all([
        CatalogStore.getBalance(s).catch((e) => `ERR ${e.message}`),
        CatalogStore.getCatalog(s, { force: true })
      ]);
      const n = catalog ? catalog.length : 0;
      const inStock = catalog ? catalog.filter((c) => (c.stock ?? 0) > 0).length : 0;
      const sample = catalog && catalog[0] ? `${catalog[0].name} @ $${catalog[0].price_usd} (stock ${catalog[0].stock})` : '-';
      console.log(
        `✓ ${s.type}#${s.id} ${String(s.name).padEnd(34)} balance=${typeof balance === 'number' ? balance : balance} ` +
          `catalog=${n} in_stock=${inStock} (${Date.now() - t0}ms) e.g. ${sample}`
      );
    } catch (err) {
      console.log(`✗ ${s.type}#${s.id} ${s.name}: ${err.message}`);
    }
    // gentle between suppliers
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log('smoke done');
  process.exit(0);
})();
