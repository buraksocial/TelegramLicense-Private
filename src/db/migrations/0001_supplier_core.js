/**
 * 0001 — Supplier core schema (additive).
 *
 * Adds the columns and tables the multi-supplier pricing/matching engine needs.
 * Existing rows are preserved; new columns get safe defaults so the old code
 * keeps working until it is replaced phase by phase.
 */
const { DEFAULT_CATALOG_POLL_MS } = require('../../constants');

module.exports = {
  label: 'supplier core schema',
  up(db, { addColumn }) {
    // ---- suppliers: behaviour beyond type/url/key ----
    addColumn(db, 'suppliers', 'enabled', 'INTEGER DEFAULT 1');
    addColumn(db, 'suppliers', 'currency', "TEXT DEFAULT 'USD'");
    addColumn(db, 'suppliers', 'usd_rate', 'REAL DEFAULT 1'); // 1 unit of supplier currency = usd_rate USD
    addColumn(db, 'suppliers', 'poll_interval_ms', `INTEGER DEFAULT ${DEFAULT_CATALOG_POLL_MS}`);
    addColumn(db, 'suppliers', 'min_stock_buffer', 'INTEGER DEFAULT 0');
    addColumn(db, 'suppliers', 'price_protected', 'INTEGER DEFAULT 0'); // bunny: must pass selling_price
    addColumn(db, 'suppliers', 'supports_tiers', 'INTEGER DEFAULT 0');
    addColumn(db, 'suppliers', 'delivery_mode', "TEXT DEFAULT 'instant'"); // instant | queued
    addColumn(db, 'suppliers', 'bot_username', 'TEXT');
    addColumn(db, 'suppliers', 'last_error', 'TEXT');
    addColumn(db, 'suppliers', 'last_ok_at', 'TEXT');
    addColumn(db, 'suppliers', 'updated_at', 'TEXT');

    // ---- products: pricing mode + margin defaults ----
    addColumn(db, 'products', 'pricing_mode', "TEXT DEFAULT 'max_profit'"); // max_profit | cheapest | manual
    addColumn(db, 'products', 'default_margin_percent', 'REAL DEFAULT 150');
    addColumn(db, 'products', 'default_floor_price', 'REAL DEFAULT 0'); // 0 = no floor
    addColumn(db, 'products', 'category_id', 'INTEGER');
    addColumn(db, 'products', 'hidden_when_unaffordable', 'INTEGER DEFAULT 0'); // 0 = show sold-out badge
    addColumn(db, 'products', 'stock_jitter', 'INTEGER DEFAULT 1'); // hide supplier concentration

    // ---- product_suppliers: per-supplier margin/floor + enable ----
    addColumn(db, 'product_suppliers', 'margin_percent', 'REAL'); // NULL => use product default
    addColumn(db, 'product_suppliers', 'floor_price', 'REAL'); // NULL => use product default
    addColumn(db, 'product_suppliers', 'enabled', 'INTEGER DEFAULT 1');
    addColumn(db, 'product_suppliers', 'note', 'TEXT');
    addColumn(db, 'product_suppliers', 'last_price_usd', 'REAL');
    addColumn(db, 'product_suppliers', 'last_stock', 'INTEGER');

    // ---- supplier_catalogs: one snapshot row per supplier service ----
    db.exec(`
      CREATE TABLE IF NOT EXISTS supplier_catalogs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_id INTEGER NOT NULL,
        remote_service_id TEXT NOT NULL,
        name TEXT,
        description TEXT,
        category_raw TEXT,
        price_usd REAL,
        stock INTEGER,
        tiers_json TEXT,
        currency TEXT,
        content_hash TEXT,
        fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (supplier_id, remote_service_id),
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
      );
    `);

    // ---- categories + product membership ----
    db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id INTEGER,
        slug TEXT UNIQUE,
        name_json TEXT,
        emoji TEXT,
        sort_order INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS product_categories (
        product_id INTEGER NOT NULL,
        category_id INTEGER NOT NULL,
        PRIMARY KEY (product_id, category_id),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
      );
    `);

    // ---- product_matches: supplier service -> local product, admin-approved ----
    db.exec(`
      CREATE TABLE IF NOT EXISTS product_matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_id INTEGER NOT NULL,
        remote_service_id TEXT NOT NULL,
        product_id INTEGER,
        score REAL DEFAULT 0,
        status TEXT DEFAULT 'pending', -- pending | approved | rejected | auto
        decided_by INTEGER,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (supplier_id, remote_service_id),
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
      );
    `);

    // ---- margin_events: admin low-margin notifications, dedup/cooldown ----
    db.exec(`
      CREATE TABLE IF NOT EXISTS margin_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        kind TEXT NOT NULL, -- low_margin | restocked | balance_low
        best_margin_pct REAL,
        served_margin_pct REAL,
        best_supplier_id INTEGER,
        served_supplier_id INTEGER,
        reason TEXT,
        notified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        supplier_id INTEGER,
        product_id INTEGER,
        payload TEXT,
        status TEXT DEFAULT 'open', -- open | ack | resolved
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ---- orders: provenance so admin can audit/edit profit ----
    addColumn(db, 'orders', 'supplier_id', 'INTEGER');
    addColumn(db, 'orders', 'remote_service_id', 'TEXT');
    addColumn(db, 'orders', 'cost_usd_at_purchase', 'REAL');
    addColumn(db, 'orders', 'margin_pct_at_purchase', 'REAL');
    addColumn(db, 'orders', 'external_order_id', 'TEXT');
    addColumn(db, 'orders', 'status', "TEXT DEFAULT 'completed'");
    addColumn(db, 'orders', 'delivered_data', 'TEXT');
    addColumn(db, 'orders', 'edited_by', 'INTEGER');
    addColumn(db, 'orders', 'edited_at', 'DATETIME');
    addColumn(db, 'orders', 'edit_note', 'TEXT');

    // reservations also need delivered_data + provenance
    addColumn(db, 'reservations', 'delivered_data', 'TEXT');
    addColumn(db, 'reservations', 'supplier_id', 'INTEGER');
  }
};
