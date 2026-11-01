/**
 * 0006 — Public REST API tables. Additive, idempotent, VDS-safe.
 */
module.exports = {
  id: '0006_api',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,           -- SHA-256 of the raw key (raw shown ONCE)
        key_preview TEXT NOT NULL,               -- first 8 chars for identification
        scopes TEXT NOT NULL DEFAULT '["catalog:read","orders:write"]',
        rate_limit_per_min INTEGER NOT NULL DEFAULT 120,
        daily_limit INTEGER,                     -- NULL = unlimited
        user_id INTEGER,                         -- account orders run against (NULL = key cannot order)
        webhook_url TEXT,
        webhook_secret TEXT,                     -- HMAC-SHA256 signing key for event payloads
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS api_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        request_id TEXT,
        key_id INTEGER,
        method TEXT,
        route TEXT,
        status INTEGER,
        code TEXT,
        ip TEXT,
        ms INTEGER,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_log_ts ON api_log(ts);
      CREATE TABLE IF NOT EXISTS api_webhook_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        key_id INTEGER,
        event TEXT,
        url TEXT,
        ok INTEGER,
        error TEXT,
        payload TEXT
      );
    `);
  }
};
