/**
 * 0004 — Launch-safe defaults + price lock table.
 *
 * Existing live products keep their CURRENT manual pricing until the admin
 * explicitly switches a product to dynamic mode (max_profit/cheapest). The
 * new tables are additive. Idempotent via a settings flag.
 */
module.exports = {
  label: 'launch-safe pricing defaults & price locks',
  up(db) {
    const flag = db.prepare("SELECT value FROM settings WHERE key = 'm0004_mode_default'").get();
    if (!flag) {
      db.prepare("UPDATE products SET pricing_mode = 'manual'").run();
      db.prepare("INSERT INTO settings (key, value) VALUES ('m0004_mode_default', 'done')").run();
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS price_locks (
        token TEXT PRIMARY KEY,
        product_id INTEGER NOT NULL,
        product_supplier_id INTEGER,
        supplier_id INTEGER,
        unit_price REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_price_locks_expiry ON price_locks (expires_at);
    `);

    // A tiny sweeper registration row (the poller prunes stale locks).
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('price_lock_ttl_ms', '600000') " +
      'ON CONFLICT(key) DO NOTHING'
    ).run();
  }
};
