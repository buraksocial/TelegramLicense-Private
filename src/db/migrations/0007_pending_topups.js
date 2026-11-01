/**
 * 0007 — pending Binance top-ups (auto-verification retry queue). Additive, idempotent.
 *
 * When a customer pastes a payment number that is not settled *yet*, the
 * order is no longer lost: it lands here and the DepositPoller credits it
 * automatically once Binance reports PAID.
 */
module.exports = {
  id: '0007_pending_topups',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_topups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        txid TEXT NOT NULL UNIQUE,
        expected_amount REAL NOT NULL DEFAULT 0,
        product_id INTEGER,
        qty INTEGER,
        source TEXT NOT NULL DEFAULT 'bot',
        status TEXT NOT NULL DEFAULT 'PENDING',
        confirmed_amount REAL,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_pending_topups_status ON pending_topups(status);
    `);
  }
};
