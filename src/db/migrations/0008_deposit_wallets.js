/**
 * 0008 — multi-network deposit wallets (USDT-BEP20, USDT-Polygon, TON,
 * USDT-TON, LTC …). Additive, idempotent, VDS-safe.
 *
 * Addresses come from a custody/aggregator provider (CoinPayments
 * create_deposit_address = persistent personal wallet; NOWPayments invoice
 * = fresh address per payment). Without provider credentials no rows can
 * exist — the feature hides itself in the UI.
 */
module.exports = {
  id: '0008_deposit_wallets',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS deposit_wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        network TEXT NOT NULL,
        address TEXT,
        address_extra TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        provider_ref TEXT,
        label TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, provider, network)
      );
      CREATE INDEX IF NOT EXISTS idx_dep_wallets_user ON deposit_wallets(user_id);
      CREATE TABLE IF NOT EXISTS deposit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        provider TEXT NOT NULL,
        network TEXT,
        user_id INTEGER,
        ref TEXT,
        amount REAL,
        amount_usd REAL,
        status TEXT,
        credited INTEGER NOT NULL DEFAULT 0,
        payload TEXT,
        UNIQUE(provider, ref)
      );
    `);
  }
};
