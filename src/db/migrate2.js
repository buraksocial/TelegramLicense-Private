const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../database.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS product_bulk_discounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    min_qty INTEGER NOT NULL,
    discount_percent REAL DEFAULT 0,
    fixed_price REAL,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
  );
`);
console.log("product_bulk_discounts table created.");
