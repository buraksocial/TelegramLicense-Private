#!/usr/bin/env node
/**
 * API test — token-bucket unit + full in-process HTTP e2e (no Telegram needed).
 * Run: SUPPLIER_DRY_RUN=1 node scripts/test_api.js
 */
const assert = require('assert');
const http = require('http');

(async () => {
  // ---------- 1) token bucket unit ----------
  const { TokenBucket, RateRegistry } = require('../src/utils/ratelimit');
  const b = new TokenBucket(60, 10);       // 1/s, burst 10
  assert.equal(b.tokens, 10);
  for (let i = 0; i < 10; i++) assert.equal(b.take(1).allowed, true, 'burst of 10');
  const r11 = b.take(1);
  assert.equal(r11.allowed, false, '11th blocked immediately');
  assert(r11.retryAfter >= 1, 'retryAfter seconds present');
  await new Promise((res) => setTimeout(res, 1100));
  assert.equal(b.take(1).allowed, true, 'refilled after 1s');
  const reg = new RateRegistry();
  const w0 = reg.consume('key:9', 60, 5, 1); // daily limit 1 — first hit passes
  assert.equal(w0.allowed, true);
  const w2 = reg.consume('key:9', 60, 5, 1); // second hit exceeds the cap
  assert.equal(w2.allowed, false);
  assert.equal(w2.limitedBy, 'daily');
  console.log('ratelimit unit: OK');

  // ---------- 2) in-process HTTP e2e ----------
  process.env.API_ENABLED = '1';
  process.env.API_PORT = '3999'; // MUST be set before anything requires src/config/env
  const { db, initDb } = require('../src/db');
  initDb(); // applies 0006_api (idempotent, VDS-safe)
  const API_PORT = 3999;
  const Api = require('../api/server');
  const adminMod = require('../web/admin');
  const server = Api.startApiServer();
  await new Promise((r) => setTimeout(r, 300));

  const uid = 559000111;
  db.prepare('INSERT OR IGNORE INTO users (id, balance) VALUES (?, 50)').run(uid);
  db.prepare('UPDATE users SET balance = 50 WHERE id = ?').run(uid);
  const key = adminMod.generateApiKey('test-key', { user_id: uid, rate_limit_per_min: 1000, scopes: ['catalog:read', 'orders:read', 'orders:write', 'wallet:read', 'wallet:write'] }, 1);
  const roKey = adminMod.generateApiKey('read-only', { user_id: uid, scopes: ['catalog:read'] }, 1);
  const slowKey = adminMod.generateApiKey('slow', { rate_limit_per_min: 5 }, 1); // for 429 hammer
  const stockIds = [
    db.prepare("INSERT INTO stocks (product_id, data, is_sold) VALUES (2,'APIT-1',0)").run().lastInsertRowid,
    db.prepare("INSERT INTO stocks (product_id, data, is_sold) VALUES (2,'APIT-2',0)").run().lastInsertRowid
  ];

  function req(method, path, { body, token, headers } = {}) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({
        host: '127.0.0.1', port: API_PORT, path, method,
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          data ? { 'Content-Length': Buffer.byteLength(data) } : {},
          token ? { Authorization: 'Bearer ' + token } : {},
          headers || {})
      }, (resp) => {
        let b = ''; resp.on('data', (c) => (b += c));
        resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: resp.statusCode, headers: resp.headers, j }); });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }

  try {
    // health public
    let x = await req('GET', '/v1/health');
    assert.equal(x.status, 200); assert(x.j.service); console.log('health: OK');

    // no auth → 401 + X-Request-Id everywhere
    x = await req('GET', '/v1/products');
    assert.equal(x.status, 401); assert(x.headers['x-request-id'], 'request id header');
    assert(x.j.error && x.j.error.code === 'UNAUTHORIZED');
    console.log('unauthenticated 401: OK');

    // authed catalog
    x = await req('GET', '/v1/products', { token: key.raw_key });
    assert.equal(x.status, 200); assert(x.j.data.length >= 1);
    assert(x.j.data[0].price_usd != null);
    assert(x.headers['x-ratelimit-limit'] === '1000', 'key rpm surfaced');
    console.log('products list: OK (' + x.j.data.length + ')');

    // scope enforcement
    x = await req('GET', '/v1/wallet', { token: roKey.raw_key });
    assert.equal(x.status, 403); assert.equal(x.j.error.code, 'FORBIDDEN_SCOPE');
    x = await req('GET', '/v1/products', { token: roKey.raw_key });
    assert.equal(x.status, 200, 'read scope works');
    console.log('scopes: OK');

    // order without idempotency key → 400
    x = await req('POST', '/v1/orders', { token: key.raw_key, body: { product_id: 2, qty: 1 } });
    assert.equal(x.status, 400); assert.equal(x.j.error.code, 'IDEMPOTENCY_REQUIRED');
    console.log('idempotency enforced: OK');

    // lock + order
    x = await req('POST', '/v1/locks', { token: key.raw_key, body: { product_id: 2 } });
    assert.equal(x.status, 200, 'lock ok: ' + JSON.stringify(x.j));
    const lockTok = x.j.lock_token;
    x = await req('POST', '/v1/orders', { token: key.raw_key, body: { product_id: 2, qty: 2, lock_token: lockTok }, headers: { 'Idempotency-Key': 'ikt-1' } });
    assert.equal(x.status, 201, 'order placed: ' + JSON.stringify(x.j));
    assert.equal(x.j.data.delivered.length, 2);
    const orderId = x.j.data.id;
    const paid = x.j.data.paid_usd; const balAfter = x.j.data.balance_after;

    // idempotent replay → same body, no double charge
    x = await req('POST', '/v1/orders', { token: key.raw_key, body: { product_id: 2, qty: 2, lock_token: lockTok }, headers: { 'Idempotency-Key': 'ikt-1' } });
    assert.equal(x.status, 200, 'replay 200');
    assert.equal(x.j.data.id, orderId, 'replay returns the ORIGINAL order');
    x = await req('GET', '/v1/wallet', { token: key.raw_key });
    assert.equal(x.j.data.balance_usd, balAfter, 'balance charged exactly once');
    console.log('order + idempotent replay: OK (paid ' + paid + ')');

    // order detail
    const firstOrderId = db.prepare('SELECT MAX(id) id FROM orders WHERE user_id=?').get(uid).id;
    x = await req('GET', '/v1/orders/' + firstOrderId, { token: key.raw_key });
    assert.equal(x.status, 200); assert.equal(x.j.data.status, 'completed');
    console.log('order detail: OK');

    // insufficient balance — small rpm key, then drain
    db.prepare('UPDATE users SET balance = 1 WHERE id = ?').run(uid);
    x = await req('POST', '/v1/locks', { token: key.raw_key, body: { product_id: 2 } });
    x = await req('POST', '/v1/orders', { token: key.raw_key, body: { product_id: 2, qty: 99, lock_token: x.j.lock_token }, headers: { 'Idempotency-Key': 'ikt-2' } });
    assert.equal(x.status, 402, 'insufficient balance: ' + JSON.stringify(x.j));
    db.prepare('UPDATE users SET balance = 50 WHERE id = ?').run(uid);
    console.log('402 insufficient: OK');

    // rate limit hammer on the 5 rpm key (catalog read costs 1) → 429 with Retry-After
    let got429 = false;
    for (let i = 0; i < 40; i++) {
      const y = await req('GET', '/v1/products', { token: slowKey.raw_key });
      if (y.status === 429) {
        got429 = true;
        assert(y.headers['retry-after'], 'Retry-After header present');
        assert.equal(y.j.error.code, 'RATE_LIMITED');
        break;
      }
    }
    assert(got429, 'rate limiting kicked in under hammering');
    console.log('429 rate limit: OK');

    // openapi + docs public
    x = await req('GET', '/v1/openapi.json');
    assert.equal(x.status, 200); assert.equal(x.j.openapi, '3.0.3');
    console.log('openapi: OK');

    console.log('api tests: all passed ✓');
  } finally {
    // cleanup (children first — transactions/user_promos have NO-ACTION FKs to users)
    db.prepare('DELETE FROM api_keys WHERE id IN (?,?,?)').run(key.id, roKey.id, slowKey.id);
    db.prepare('DELETE FROM transactions WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM user_promos WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM reservations WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM orders WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM price_locks WHERE product_id = 2').run();
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    db.prepare("DELETE FROM stocks WHERE data LIKE 'APIT-%'").run();
    server.close();
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message, e.stack && e.stack.split('\n')[1]); process.exit(1); });
