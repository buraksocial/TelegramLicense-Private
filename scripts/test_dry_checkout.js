#!/usr/bin/env node
/** End-to-end dry-run checkout test with simulated balances. */
const { db } = require('../src/db');
const CatalogStore = require('../src/services/CatalogStore');

// Simulate funded suppliers without touching the network.
CatalogStore.getBalance = async () => 100;

(async () => {
  const SM = require('../src/services/SupplierManager');
  db.prepare("UPDATE products SET pricing_mode='max_profit' WHERE id = 2").run();
  const p = db.prepare('SELECT * FROM products WHERE id = 2').get();

  try {
    const r = await SM.placeOrder(p, 1, { sellPriceUnit: 3.5 });
    console.log('placeOrder OK:', JSON.stringify({
      supplier_id: r.supplier_id,
      remote: r.remote_service_id,
      result: r.result
    }, null, 2).slice(0, 700));
  } catch (e) {
    console.error('placeOrder FAILED:', e.message);
    if (e.attempts) console.error('attempts:', JSON.stringify(e.attempts));
    console.error(e.stack.split('\n').slice(0, 15).join('\n'));
  }

  db.prepare("UPDATE products SET pricing_mode='manual' WHERE id = 2").run();
  process.exit(0);
})();
