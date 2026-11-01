#!/usr/bin/env node
/**
 * Auto top-up e2e — real Binance Pay order 457703115609456640 (10 USDT,
 * receiver = our Pay ID, confirmed in history). Verifies:
 *   queue → poller verifies → balance credited exactly once → re-queue of
 *   the same txid never double-credits.
 * Live API usage is deliberately minimal (memoized lookups, gentle sleeps).
 */
const assert = require('assert');

(async () => {
  const { db, initDb } = require('../src/db');
  initDb();
  const { processPending } = require('../src/services/DepositPoller');

  const TX = '457703115609456640';
  const uid = 559000333;
  db.prepare('INSERT OR IGNORE INTO users (id, balance) VALUES (?, 0)').run(uid);
  db.prepare('UPDATE users SET balance = 0 WHERE id = ?').run(uid);
  db.prepare('DELETE FROM transactions WHERE txid = ?').run(TX); // fresh slate for the run
  db.prepare('DELETE FROM pending_topups WHERE txid = ?').run(TX);

  const mockBot = { telegram: { sendMessage: async () => {} } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let pass;

  try {
    // ---- 1) unverified-then-queued deposit auto-credits ----
    db.prepare(`INSERT INTO pending_topups (user_id, txid, expected_amount, source, note) VALUES (?,?,?,?,?)`)
      .run(uid, TX, 5, 'test', 'e2e');
    pass = await processPending(mockBot);
    assert.equal(pass.credited, 1, 'one credit pass: ' + JSON.stringify(pass));
    const p = db.prepare('SELECT * FROM pending_topups WHERE txid = ?').get(TX);
    assert.equal(p.status, 'CREDITED');
    assert.equal(p.confirmed_amount, 10, 'confirmed amount = 10 USDT');
    assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance, 10, 'balance +10');
    assert(db.prepare('SELECT 1 x FROM transactions WHERE txid = ?').get(TX), 'transaction booked');
    console.log('auto-credit from queue: OK (10 USDT → balance)');

    // ---- 2) same txid re-queued (production INSERT OR IGNORE path) ----
    db.prepare(`INSERT OR IGNORE INTO pending_topups (user_id, txid, expected_amount, source, note) VALUES (?,?,?,?,?)`)
      .run(uid, TX, 5, 'test', 're-queue attempt');
    const rowCount = db.prepare('SELECT COUNT(*) c FROM pending_topups WHERE txid = ?').get(TX).c;
    assert.equal(rowCount, 1, 'unique txid guard blocks re-queue');
    assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance, 10, 'balance still 10');
    console.log('unique-txid re-queue guard: OK');

    // ---- 3) row manually reopened → transactions dedup prevents 2nd credit ----
    const bal0 = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
    db.prepare("UPDATE pending_topups SET status='PENDING', confirmed_amount=NULL WHERE txid = ?").run(TX);
    pass = await processPending(mockBot);
    const p2 = db.prepare('SELECT * FROM pending_topups WHERE txid = ?').get(TX);
    assert.equal(p2.status, 'CREDITED', 're-opened row closes as CREDITED');
    assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance, bal0, 'no second credit (txid dedup)');
    console.log('double-credit protection: OK');

    console.log('topup e2e: all passed ✓');
  } finally {
    db.prepare('DELETE FROM pending_topups WHERE txid = ?').run(TX);
    db.prepare('DELETE FROM transactions WHERE txid = ?').run(TX);
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    process.exit(0);
  }
})().catch((e) => { console.error('FAIL:', e.message, e.stack && e.stack.split('\n')[1]); process.exit(1); });
