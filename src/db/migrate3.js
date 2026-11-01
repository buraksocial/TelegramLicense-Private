const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../database.sqlite'));

try {
  db.exec(`ALTER TABLE products ADD COLUMN api_service_id TEXT`);
  db.exec(`ALTER TABLE products ADD COLUMN auto_restock_enabled INTEGER DEFAULT 0`);
  db.exec(`ALTER TABLE products ADD COLUMN auto_restock_qty INTEGER DEFAULT 5`);
  console.log("Added api columns to products.");
} catch (e) {
  console.log("Columns might already exist:", e.message);
}
