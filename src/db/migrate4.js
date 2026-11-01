const { db } = require('./index');
const { LOOTPAGLU_BASE_URL, LOOTPAGLU_API_KEY } = require('../config/env');

function runMigration() {
  console.log('Running migration 4: Setting up default LootPaglu supplier...');

  // 1. Create a default LootPaglu supplier if it doesn't exist
  let lootpaglu = db.prepare("SELECT * FROM suppliers WHERE type = 'lootpaglu'").get();
  if (!lootpaglu) {
    const info = db.prepare("INSERT INTO suppliers (name, type, base_url, api_key) VALUES (?, ?, ?, ?)").run(
      'LootPaglu (Default)', 'lootpaglu', LOOTPAGLU_BASE_URL, LOOTPAGLU_API_KEY
    );
    lootpaglu = { id: info.lastInsertRowid };
  }

  // 2. Move existing api_service_id from products to product_suppliers
  const productsWithApi = db.prepare("SELECT id, api_service_id FROM products WHERE api_service_id IS NOT NULL AND api_service_id != ''").all();
  
  const checkSupplier = db.prepare("SELECT * FROM product_suppliers WHERE product_id = ? AND supplier_id = ?");
  const insertSupplier = db.prepare("INSERT INTO product_suppliers (product_id, supplier_id, remote_service_id, priority) VALUES (?, ?, ?, 1)");
  
  for (const p of productsWithApi) {
    const exists = checkSupplier.get(p.id, lootpaglu.id);
    if (!exists) {
      insertSupplier.run(p.id, lootpaglu.id, p.api_service_id);
    }
  }

  console.log('Migration 4 completed successfully.');
}

if (require.main === module) {
  runMigration();
}

module.exports = runMigration;
