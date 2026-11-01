const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../../database.sqlite');
const db = new Database(dbPath);

// Tabloları oluşturan init fonksiyonu
function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      lang TEXT DEFAULT 'en',
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      description TEXT,
      api_service_id TEXT,
      auto_restock_enabled INTEGER DEFAULT 0,
      auto_restock_qty INTEGER DEFAULT 5,
      auto_restock_threshold INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS product_bulk_discounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      min_qty INTEGER NOT NULL,
      discount_percent REAL DEFAULT 0,
      fixed_price REAL,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS stocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      data TEXT NOT NULL,
      is_sold BOOLEAN DEFAULT 0,
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      txid TEXT UNIQUE NOT NULL,
      user_id INTEGER,
      product_id INTEGER,
      amount REAL,
      status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

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

    CREATE TABLE IF NOT EXISTS promo_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      value REAL NOT NULL,
      max_uses INTEGER DEFAULT 1,
      expiry_hours INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_promos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      promo_id INTEGER,
      activated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(promo_id) REFERENCES promo_codes(id)
    );

    CREATE TABLE IF NOT EXISTS ranks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      min_purchases INTEGER NOT NULL,
      discount_percent REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS rank_special_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rank_id INTEGER,
      product_id INTEGER,
      special_price REAL NOT NULL,
      FOREIGN KEY(rank_id) REFERENCES ranks(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS resellers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE,
      balance REAL DEFAULT 0,
      balance_limit REAL DEFAULT 0,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reseller_users (
      reseller_id INTEGER,
      user_id INTEGER,
      PRIMARY KEY (reseller_id, user_id),
      FOREIGN KEY(reseller_id) REFERENCES resellers(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      product_id INTEGER,
      qty INTEGER,
      cost_usd REAL,
      sell_usd REAL,
      profit_usd REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      base_url TEXT,
      api_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS product_suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      supplier_id INTEGER,
      remote_service_id TEXT NOT NULL,
      priority INTEGER DEFAULT 1,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY(supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
    );

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
      unit_price REAL,
      status TEXT DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );
  `);

  // Migrate existing users table to add lang column if it doesn't exist
  try {
    db.exec(`ALTER TABLE users ADD COLUMN lang TEXT DEFAULT 'en'`);
  } catch (err) {
    // Column might already exist, ignore error
  }

  // Mega Update Migrations
  ['balance REAL DEFAULT 0', 'referred_by INTEGER', 'total_purchases INTEGER DEFAULT 0', 'reseller_promo_ban INTEGER DEFAULT 0'].forEach(col => {
    try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch (e) {}
  });

  ['auto_restock_threshold INTEGER DEFAULT 0', 'cost_usd REAL DEFAULT 0', 'supplier_selection_mode TEXT DEFAULT "priority"', 'is_active INTEGER DEFAULT 1'].forEach(col => {
    try { db.exec(`ALTER TABLE products ADD COLUMN ${col}`); } catch (e) {}
  });

  ['cost_try REAL DEFAULT 0', 'sell_try REAL DEFAULT 0', 'profit_try REAL DEFAULT 0'].forEach(col => {
    try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`); } catch (e) {}
  });
  
  try { db.exec(`ALTER TABLE transactions ADD COLUMN amount_try REAL DEFAULT 0`); } catch (e) {}
  try { db.exec(`ALTER TABLE reservations ADD COLUMN unit_price REAL DEFAULT 0`); } catch (e) {}
  
  // Custom adapter migrations
  try { db.exec(`ALTER TABLE suppliers ADD COLUMN bot_username TEXT`); } catch(e) {}
  try { db.exec(`ALTER TABLE product_suppliers ADD COLUMN manual_tiers TEXT`); } catch(e) {}
  try { db.exec(`ALTER TABLE users ADD COLUMN custom_reservation_fee REAL`); } catch(e) {}

  // Auto-seed AixShopBot if it doesn't exist
  try {
    db.exec(`
      INSERT INTO suppliers (name, type, bot_username)
      SELECT 'AixShopBot', 'aixshopbot', 'Aixshopbot'
      WHERE NOT EXISTS (SELECT 1 FROM suppliers WHERE type = 'aixshopbot');
    `);
  } catch(e) {}

  // Versioned, additive-only migrations (safe on a live VDS database).
  require('./migrator').run(db);
}

module.exports = {
  db,
  initDb
};
