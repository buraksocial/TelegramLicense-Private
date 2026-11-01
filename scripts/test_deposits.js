#!/usr/bin/env node
/**
 * Multi-network deposits — OFFLINE e2e (provider HTTP is mocked, no keys).
 * Covers: wallet creation (NP), idempotent credit, IPN signature verify
 * (NP sha256 + CP sha1), address-based CP mapping, duplicate protection.
 */
const assert = require('assert');
const crypto = require('crypto');

process.env.DEPOSIT_PROVIDER = 'nowpayments';
process.env.NOWPAYMENTS_API_KEY = 'np-test-key';
process.env.NOWPAYMENTS_IPN_SECRET = 'np-ipn-secret';
process.env.COINPAYMENTS_IPN_SECRET = 'cp-ipn-secret';

const { db, initDb } = require('../src/db');
initDb();
const DepSvc = require('../src/services/DepositProviders');

const uid = 559000444;
const mockWallets = {};
db.prepare('INSERT OR IGNORE INTO users (id, balance) VALUES (?, 0)').run(uid);
db.prepare('UPDATE users SET balance = 0 WHERE id = ?').run(uid);

(async () => {
  // ---------- mocked provider HTTP ----------
  DepSvc.setHttpClient(async (opts) => {
    const u = String(opts.url);
    if (u.includes('/v1/invoice') && !u.includes('check')) {
      const body = typeof opts.data === 'string' ? JSON.parse(opts.data) : opts.data;
      mockWallets.invoice = body.order_id;
      return { id: 987654, invoice_url: 'https://nowpayments.io/pay/987654', payment_address: 'TNP_MOCK_ADDRESS_1', status: 'waiting' };
    }
    if (u.includes('/check')) {
      return { result: { payment_status: 'waiting', price: 1 } };
    }
    throw new Error('unexpected http ' + u);
  });

  try {
    // ---------- 1) wallet creation ----------
    assert.equal(DepSvc.providerConfigured(), true, 'provider configured');
    const nets = DepSvc.enabledNetworks();
    assert(nets.find((n) => n.key === 'usdt_bep20'), 'bep20 in catalog');
    assert(nets.find((n) => n.key === 'ton'), 'ton in catalog');
    const w = await DepSvc.getDepositWallet(uid, 'usdt_bep20');
    assert.equal(w.address, 'TNP_MOCK_ADDRESS_1');
    assert.equal(w.provider_ref, '987654');
    assert.equal(w.user_id, uid);
    console.log('wallet creation (mocked NP): OK —', w.address);

    // ---------- 2) IPN signature ----------
    const payload = JSON.stringify({ payment_id: 'p-777', order_id: `DP${uid}-usdt_bep20-abc123`, payment_status: 'finished', outcome_amount: 12.5 });
    const sig = crypto.createHmac('sha256', 'np-ipn-secret').update(payload).digest('hex');
    assert.equal(DepSvc.verifyNpSignature(payload, sig), true);
    assert.equal(DepSvc.verifyNpSignature(payload, sig.toUpperCase().replace('0', '1')), false);
    assert.equal(DepSvc.verifyNpSignature(payload, ''), false);
    console.log('nowpayments IPN HMAC: OK (forged rejected)');

    // ---------- 3) idempotent credit ----------
    const before = db.prepare('SELECT balance FROM users WHERE id=?').get(uid).balance;
    const r1 = await DepSvc.handleNpIpn(JSON.parse(payload), null);
    assert.equal(r1.ok, true, 'first credit ok: ' + JSON.stringify(r1));
    assert.equal(r1.usd, 12.5);
    const after = db.prepare('SELECT balance FROM users WHERE id=?').get(uid).balance;
    assert.equal(Math.round((after - before) * 100) / 100, 12.5, 'balance +12.5');
    const r2 = await DepSvc.handleNpIpn(JSON.parse(payload), null);
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'dup');
    assert.equal(db.prepare('SELECT balance FROM users WHERE id=?').get(uid).balance, after, 'no double credit');
    const txRow = db.prepare("SELECT 1 x FROM transactions WHERE txid = 'nowpayments:p-777'").get();
    assert(txRow, 'transaction booked with provider:ref txid');
    console.log('IPN credit + duplicate protection: OK');

    // ---------- 4) coinpayments signature + address mapping ----------
    db.prepare(`INSERT INTO deposit_wallets (user_id, provider, network, address, address_extra, provider_ref, status)
                VALUES (?, 'coinpayments', 'ton', 'UQB_MOCK', '9911', '55', 'ACTIVE')`).run(uid);
    const cpBody = new URLSearchParams({ status: '1', txn_id: 'cp-tx-1', amount1: '7.75', currency1: 'ton', address: 'UQB_MOCK' }).toString();
    const cpSig = crypto.createHmac('sha1', 'cp-ipn-secret').update(cpBody).digest('hex');
    assert.equal(DepSvc.verifyCpSignature(cpBody, cpSig), true);
    assert.equal(DepSvc.verifyCpSignature(cpBody, 'deadbeef'), false);
    const fields = Object.fromEntries(new URLSearchParams(cpBody));
    const cr = await DepSvc.handleCpIpn(fields, null);
    assert.equal(cr.ok, true, 'cp credit: ' + JSON.stringify(cr));
    assert.equal(cr.usd, 7.75);
    // TON memo present for the customer-facing card
    const cpw = db.prepare("SELECT * FROM deposit_wallets WHERE address='UQB_MOCK'").get();
    assert.equal(cpw.address_extra, '9911', 'memo stored for TON');
    console.log('coinpayments HMAC + address-mapped credit: OK');

    // ---------- 5) unknown address is ignored ----------
    const bad = await DepSvc.handleCpIpn({ status: '1', txn_id: 'x', amount1: '500', address: 'NOBODY' }, null);
    assert.equal(bad.ignored, 'unknown address');
    console.log('unmapped address rejected: OK');

    console.log('deposits e2e: all passed ✓');
  } catch (e) {
    console.error('FAIL:', e.message, e.stack && e.stack.split('\n')[1]);
    process.__testFailed = true;
  } finally {
    db.prepare('DELETE FROM deposit_events WHERE user_id = ?').run(uid);
    db.prepare("DELETE FROM transactions WHERE txid LIKE 'nowpayments:%' OR txid LIKE 'coinpayments:%'").run();
    db.prepare('DELETE FROM deposit_wallets WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    process.exit(process.__testFailed ? 1 : 0);
  }
})();
