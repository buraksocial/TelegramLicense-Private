const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../../database.sqlite');
const db = new Database(dbPath);

console.log("Running migrations...");

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      discount_percent REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pricing_group_products (
      group_id INTEGER,
      product_id INTEGER,
      price REAL NOT NULL,
      PRIMARY KEY (group_id, product_id),
      FOREIGN KEY(group_id) REFERENCES pricing_groups(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_pricing_groups (
      user_id INTEGER PRIMARY KEY,
      group_id INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(group_id) REFERENCES pricing_groups(id) ON DELETE CASCADE
    );
  `);
  console.log("Pricing group tables created.");
} catch (e) {
  console.error("Error creating pricing tables", e);
}

try {
  db.exec(`ALTER TABLE products ADD COLUMN bulk_discount_qty INTEGER DEFAULT 0`);
  db.exec(`ALTER TABLE products ADD COLUMN bulk_discount_percent REAL DEFAULT 0`);
  console.log("Added bulk discount columns to products.");
} catch (e) {
  console.log("Bulk columns might already exist:", e.message);
}

console.log("Migrations complete.");
