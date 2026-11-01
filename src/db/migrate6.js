const { db } = require('./index');

console.log("Running migration 6: Creating reservations table...");

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      product_id INTEGER,
      qty INTEGER,
      fulfilled_qty INTEGER DEFAULT 0,
      cost_usd REAL,
      sell_usd REAL,
      profit_usd REAL,
      cost_try REAL,
      sell_try REAL,
      profit_try REAL,
      status TEXT DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );
  `);
  console.log("Migration 6 completed successfully.");
} catch (err) {
  console.error("Migration 6 failed:", err.message);
}
