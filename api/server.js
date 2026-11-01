/**
 * Public REST API — bot-api.developer.org.tr  (v1)
 * ================================================
 * Dependency-free (node:http) programmatic front for the SAME brain as the
 * bot/web store: CheckoutService + PricingEngine (warranty gating included).
 *
 * Architecture
 *  /v1/health          — liveness + basics (no auth)
 *  /v1/openapi.json    — machine-readable spec (no auth)
 *  /v1/docs            — human console for the spec (no auth)
 *  Everything else     — Authorization: Bearer <api-key>
 *
 * Auth model
 *  - API keys (sk-…) are created in the web admin panel; only SHA-256 hashes
 *    are stored, the raw key is shown exactly once.
 *  - Each key carries: name, scopes[], rate_limit_per_min, daily_limit,
 *    optional bound user_id (orders run against that account's balance and
 *    see that account's discounts), optional webhook_url + HMAC secret.
 *
 * Rate limiting (layered)
 *  1. Per-IP bucket (unauth'd traffic too): IP_RPM env, default 600/min —
 *     stops floods and key-less abuse.
 *  2. Per-key token bucket at the key's own rate; WEIGHTED COSTS: catalog
 *     reads cost 1, order placement costs 8 (each order fans out to supplier
 *     APIs + LLM-free but DB-heavy work), so read-abuse can't starve writes.
 *  3. Daily quota (UTC day) per key when configured.
 *  All decisions surface via standard headers:
 *     X-RateLimit-Limit / -Remaining / -Reset, Retry-After on 429.
 *  4. Supplier-side safety is inherited: every catalog/balance/order call
 *     still passes the global RateGovernor (12s bucket per supplier family),
 *     so even a flooded API can never get the bot 429-banned upstream.
 *
 * Request lifecycle
 *  request-id → CORS → body guard → IP bucket → auth → key bucket+quota →
 *  scope → handler → envelope → async webhook + audit log (errors/slow only)
 *
 * Errors are uniform: { error: { code, message, request_id } }
 */
const http = require('http');
const crypto = require('crypto');
const { db } = require('../src/db');
const CS = require('../src/services/CheckoutService');
const { PricingEngine } = require('../src/services/PricingEngine');
const { RateRegistry } = require('../src/utils/ratelimit');
const { parseQuantity, parseMoney } = require('../src/utils/money');
const { API_PORT, API_ENABLED, API_CORS_ORIGIN, API_DEFAULT_RPM, ADMIN_ID, SUPPLIER_DRY_RUN } = require('../src/config/env');

const V = '/v1/';
const IP_RPM = parseInt(process.env.API_IP_RPM, 10) || 600;
const MAX_BODY = 256 * 1024;
const IDEM_TTL_MS = 24 * 3600 * 1000;

const registry = new RateRegistry();
registry.start();
const IDEMPOTENCY = new Map();      // "keyId:idem" -> { at, status, body }
const SUMMARY_CACHE = new Map();    // "userId:productId" -> { at, data } (20s)
const SUM_TTL = 20000;

// ---------------------------------------------------------------- helpers
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const hashKey = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const reqId = () => crypto.randomBytes(5).toString('hex');

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fail(status, code, message, rid) {
  return { status, body: { error: { code, message, request_id: rid } } };
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket.remoteAddress || '?').replace('::ffff:', '');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > MAX_BODY) { reject(new ApiError(413, 'BODY_TOO_LARGE', 'request body exceeds 256KB')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new ApiError(400, 'INVALID_JSON', 'body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- auth
function authenticate(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw new ApiError(401, 'UNAUTHORIZED', 'missing Authorization: Bearer <api-key>');
  const raw = h.slice(7).trim();
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND enabled = 1').get(hashKey(raw));
  if (!row) throw new ApiError(401, 'UNAUTHORIZED', 'invalid or revoked api key');
  // throttled last_used touch (avoid a write per request)
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at + 'Z').getTime() > 60000) {
    db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  }
  let scopes = [];
  try { scopes = JSON.parse(row.scopes || '[]'); } catch (e) {}
  return { key: row, scopes };
}

function hasScope(scopes, need) {
  const [g, a] = String(need).split(':');
  return scopes.some((s) => s === '*' || s === need || s === `${g}:*` || (a === 'read' && s === `${g}`));
}
function needScope(ctx, s) {
  if (!hasScope(ctx.scopes, s)) {
    throw new ApiError(403, 'FORBIDDEN_SCOPE', `api key lacks scope '${s}'`);
  }
}
function needUser(ctx) {
  if (!ctx.key.user_id) {
    throw new ApiError(403, 'NO_ACCOUNT', 'this api key is not bound to a user account (set one in the admin panel)');
  }
  return ctx.key.user_id;
}

// ---------------------------------------------------------------- response
function send(res, rid, status, body, rate = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Request-Id': rid,
    'X-Api-Version': '1.0',
    'Access-Control-Allow-Origin': API_CORS_ORIGIN,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After',
    'Cache-Control': 'no-store'
  };
  if (rate.limit != null) headers['X-RateLimit-Limit'] = String(rate.limit);
  if (rate.remaining != null) headers['X-RateLimit-Remaining'] = String(rate.remaining);
  if (rate.reset != null) headers['X-RateLimit-Reset'] = String(rate.reset);
  if (rate.retryAfter) headers['Retry-After'] = String(rate.retryAfter);
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, headers);
  res.end(json);
}

// ---------------------------------------------------------------- webhooks
function fireWebhook(keyRow, event, payloadObj) {
  if (!keyRow || !keyRow.webhook_url) return;
  const body = JSON.stringify({ event, sent_at: new Date().toISOString(), data: payloadObj });
  const sig = keyRow.webhook_secret
    ? 'sha256=' + crypto.createHmac('sha256', keyRow.webhook_secret).update(body).digest('hex')
    : '';
  let u;
  try { u = new URL(keyRow.webhook_url); } catch (e) { return; }
  const mod = u.protocol === 'https:' ? require('https') : require('http');
  const t0 = Date.now();
  const r = mod.request(u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Api-Event': event, 'X-Api-Signature': sig },
    timeout: 8000
  }, (resp) => {
    let buf = ''; resp.on('data', (c) => (buf += c));
    resp.on('end', () => {
      const ok = resp.statusCode >= 200 && resp.statusCode < 300;
      logWebhook(keyRow.id, event, keyRow.webhook_url, ok, ok ? null : `HTTP ${resp.statusCode}`);
    });
  });
  r.on('error', (e) => logWebhook(keyRow.id, event, keyRow.webhook_url, false, e.message));
  r.on('timeout', () => { r.destroy(new Error('timeout')); });
  r.end(body);
  void t0;
}
function logWebhook(keyId, event, url, ok, error) {
  try {
    db.prepare('INSERT INTO api_webhook_log (key_id, event, url, ok, error) VALUES (?,?,?,?,?)')
      .run(keyId, event, String(url).slice(0, 200), ok ? 1 : 0, error);
  } catch (e) {}
}

// ---------------------------------------------------------------- audit log
let logCounter = 0;
function audit(entry) {
  try {
    db.prepare('INSERT INTO api_log (request_id, key_id, method, route, status, code, ip, ms, detail) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(entry.rid, entry.keyId || null, entry.method, entry.route, entry.status, entry.code || null, entry.ip, entry.ms || null, entry.detail || null);
    if (++logCounter % 500 === 0) {
      const cut = db.prepare('SELECT MAX(id) m FROM api_log').get().m - 20000;
      if (cut > 0) db.prepare('DELETE FROM api_log WHERE id < ?').run(cut);
    }
  } catch (e) { /* logging must never break traffic */ }
}

// ---------------------------------------------------------------- endpoints
const routes = [];
function route(method, pattern, scope, cost, handler) {
  routes.push({ method, pattern, scope, cost, handler });
}

// health — no auth, no key bucket (IP bucket only)
route('GET', /^health$/, null, 1, async () => ({
  service: 'license-bot-api', version: '1.0', time: new Date().toISOString(),
  mode: SUPPLIER_DRY_RUN ? 'dry_run' : 'live',
  counts: {
    products: db.prepare('SELECT COUNT(*) c FROM products WHERE is_active=1').get().c,
    suppliers: db.prepare('SELECT COUNT(*) c FROM suppliers WHERE enabled=1').get().c,
    keys: db.prepare('SELECT COUNT(*) c FROM api_keys WHERE enabled=1').get().c
  }
}));

route('GET', /^categories$/, 'catalog:read', 1, async () => {
  const cats = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order').all();
  return { data: cats.map((c) => {
    let name = c.slug; try { const j = JSON.parse(c.name_json); name = j; } catch (e) {}
    return { id: c.id, slug: c.slug, emoji: c.emoji, names: name };
  }) };
});

route('GET', /^products$/, 'catalog:read', 1, async (ctx, req, res, url) => {
  const catId = url.searchParams.get('category_id');
  const q = (url.searchParams.get('q') || '').toLowerCase().trim();
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 20));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset'), 10) || 0);
  let products = db.prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY id').all();
  if (catId) {
    const ids = new Set(db.prepare('SELECT product_id FROM product_categories WHERE category_id = ?').all(Number(catId)).map((r) => r.product_id));
    products = products.filter((p) => ids.has(p.id));
  }
  if (q) products = products.filter((p) => String(p.name).toLowerCase().includes(q));
  const uid = ctx.key.user_id;
  const data = [];
  for (const p of products.slice(offset, offset + limit)) {
    const s = await summaryCached(uid, p);
    data.push({
      id: p.id, warranty: p.warranty || 'none', pricing_mode: s.mode,
      price_usd: s.unit, stock: s.stock, available: !s.soldOut,
      names: safeJson(p.name), descriptions: safeJson(p.description)
    });
  }
  return { data, meta: { limit, offset, total: products.length } };
});

route('GET', /^products\/(\d+)$/, 'catalog:read', 2, async (ctx, req, res, url, m) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(Number(m[1]));
  if (!product) throw new ApiError(404, 'NOT_FOUND', 'product not found');
  const uid = ctx.key.user_id;
  const s = await summaryCached(uid, product);
  const out = {
    id: product.id, warranty: product.warranty || 'none', pricing_mode: s.mode,
    price_usd: s.unit, stock: s.stock, available: !s.soldOut,
    names: safeJson(product.name), descriptions: safeJson(product.description)
  };
  if (s.decision) {
    out.services = CS.serviceLines(product, s.decision, 'en', uid)
      .filter((x) => x.reason !== 'warranty_mismatch')
      .map((x) => ({
        service_id: x.psId, name: x.name, price_usd: x.sellUnit,
        stock: x.stock, available: x.affordable, best: !!x.best, warranty_class: x.warranty
      }));
  }
  return out;
});

route('POST', /^locks$/, 'orders:write', 2, async (ctx, req) => {
  const body = await readBody(req);
  needScope(ctx, 'orders:write');
  const uid = needUser(ctx);
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(Number(body.product_id));
  if (!product) throw new ApiError(404, 'NOT_FOUND', 'product not found');
  const mode = product.pricing_mode || 'manual';
  if (mode === 'manual') {
    const token = CS.issuePriceLock(product, null, round2(product.price));
    return { lock_token: token, unit_usd: round2(CS.getUserUnitPrice(uid, product)), mode, expires_in: 600 };
  }
  const decision = await CS.productDecision(product, 1);
  if (!decision) throw new ApiError(500, 'PRICING_UNAVAILABLE', 'pricing engine failed');
  let offer = null;
  if (body.service_id) {
    offer = decision.all.find((o) => o.product_supplier_id === Number(body.service_id) && o.affordable && o.reason !== 'warranty_mismatch');
    if (!offer) throw new ApiError(409, 'SERVICE_UNAVAILABLE', 'that service cannot fulfill this product right now');
  } else {
    offer = decision.priceOffer;
    if (!offer) throw new ApiError(409, 'SOLD_OUT', 'product currently cannot be fulfilled');
  }
  const token = CS.issuePriceLock(product, offer, offer.sellUnit);
  return {
    lock_token: token, unit_usd: round2(CS.getUserUnitPrice(uid, product, offer.sellUnit)),
    service_id: offer.product_supplier_id, warranty_class: offer.warranty, mode, expires_in: 600
  };
});

route('POST', /^orders$/, 'orders:write', 8, async (ctx, req, res, url, m, rid) => {
  needUser(ctx);
  const idemKey = req.headers['idempotency-key'];
  if (!idemKey) throw new ApiError(400, 'IDEMPOTENCY_REQUIRED', 'POST /v1/orders requires an Idempotency-Key header');
  const slot = `${ctx.key.id}:${idemKey}`;
  const hit = IDEMPOTENCY.get(slot);
  if (hit && Date.now() - hit.at < IDEM_TTL_MS) {
    return { __replay: true, status: hit.status, body: hit.body };
  }

  const uid = ctx.key.user_id;
  const body = await readBody(req);
  const qty = parseQuantity(String(body.qty == null ? '' : body.qty));
  if (qty === null || isNaN(qty) || qty <= 0 || qty > 500) throw new ApiError(400, 'VALIDATION', 'qty must be an integer 1..500');
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(Number(body.product_id));
  if (!product) throw new ApiError(404, 'NOT_FOUND', 'product not found');

  const lock = body.lock_token ? CS.readPriceLock(body.lock_token) : null;
  if (body.lock_token && (!lock || lock.product_id !== product.id)) {
    throw new ApiError(410, 'LOCK_EXPIRED', 'price lock invalid or expired — re-lock then order');
  }
  if ((product.pricing_mode || 'manual') !== 'manual' && !lock) {
    throw new ApiError(400, 'LOCK_REQUIRED', 'dynamic-priced products must be ordered with a fresh lock_token (POST /v1/locks)');
  }
  const unitBase = lock ? lock.unit_price : null;
  const total = round2(CS.calculateTotalPrice(uid, product, qty, unitBase));
  const reserve = !!body.reserve;

  const bal = round2(db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance || 0);
  if (bal < total) throw new ApiError(402, 'INSUFFICIENT_BALANCE', `balance ${bal}$ < required ${total}$ (top up or ask admin for credit)`);

  const txid = `API_${uid}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(total, uid);
  let result;
  try {
    result = await CS.fulfill(uid, product, qty, {
      paidAmount: total, unitBase, chosenPs: lock ? lock.psId : null,
      txid, isReservation: reserve, trueMissing: reserve ? qty : undefined, source: 'api'
    });
  } catch (e) {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(total, uid); // refund
    if (e instanceof CS.CheckoutError) {
      const st = e.code === 'not_enough_stock' ? 409 : 409;
      throw new ApiError(st, e.code.toUpperCase(), e.message);
    }
    throw e;
  }

  const out = {
    id: result.order_id, kind: result.kind, product_id: product.id, qty,
    paid_usd: total, balance_after: round2(db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance),
    delivered: result.kind === 'delivered' ? result.delivered : null,
    txid, status: result.kind === 'delivered' ? 'completed' : 'pending_reservation'
  };
  IDEMPOTENCY.set(slot, { at: Date.now(), status: 200, body: { data: out } });
  fireWebhook(ctx.key, 'order.created', out);
  try {
    const bot = global.__LICENSE_BOT;
    if (bot && bot.telegram && ADMIN_ID) {
      bot.telegram.sendMessage(ADMIN_ID, `🤖 <b>API siparişi</b>\nkey #${ctx.key.id} (${ctx.key.name}) → ${CS.localized(product, 'en')} × ${qty}\n💰 $${total}${reserve ? ' (rezerv)' : ''}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  } catch (e) {}
  return { status: 201, body: { data: out } };
});

route('GET', /^orders$/, 'orders:read', 1, async (ctx, req, res, url) => {
  const uid = needUser(ctx);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 20));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset'), 10) || 0);
  const rows = db.prepare(`
    SELECT o.id, o.product_id, o.qty, o.sell_usd, o.created_at, o.status, o.delivered_data, p.name AS product_name
    FROM orders o LEFT JOIN products p ON p.id=o.product_id
    WHERE o.user_id = ? ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(uid, limit, offset);
  return {
    data: rows.map((o) => ({
      id: o.id, product_id: o.product_id, product: CS.localized({ name: o.product_name }, 'en'),
      qty: o.qty, paid_usd: round2(o.sell_usd), date: o.created_at,
      status: o.status || 'completed', delivered: safeJsonArr(o.delivered_data)
    })),
    meta: { limit, offset }
  };
});

route('GET', /^orders\/(\d+)$/, 'orders:read', 1, async (ctx, req, res, url, m) => {
  const uid = needUser(ctx);
  const o = db.prepare('SELECT o.*, p.name AS product_name FROM orders o LEFT JOIN products p ON p.id=o.product_id WHERE o.id = ? AND o.user_id = ?').get(Number(m[1]), uid);
  if (!o) throw new ApiError(404, 'NOT_FOUND', 'order not found for this account');
  return {
    data: {
      id: o.id, product_id: o.product_id, product: CS.localized({ name: o.product_name }, 'en'),
      qty: o.qty, paid_usd: round2(o.sell_usd), date: o.created_at,
      status: o.status || 'completed', delivered: safeJsonArr(o.delivered_data),
      supplier_ref: o.external_order_id || null
    }
  };
});

route('GET', /^wallet$/, 'wallet:read', 1, async (ctx) => {
  const uid = needUser(ctx);
  const u = db.prepare('SELECT balance, total_purchases FROM users WHERE id = ?').get(uid);
  const promos = db.prepare(`
    SELECT p.code, p.type, p.value, up.expires_at FROM user_promos up
    JOIN promo_codes p ON p.id = up.promo_id
    WHERE up.user_id = ? AND (up.expires_at IS NULL OR up.expires_at > CURRENT_TIMESTAMP)`).all(uid);
  return { data: { balance_usd: round2(u.balance || 0), total_purchases: u.total_purchases || 0, active_promos: promos } };
});

route('GET', /^wallet\/transactions$/, 'wallet:read', 1, async (ctx, req, res, url) => {
  const uid = needUser(ctx);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 20));
  const rows = db.prepare('SELECT txid, amount, status, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(uid, limit);
  return { data: rows, meta: { limit } };
});

route('POST', /^wallet\/promo$/, 'wallet:write', 2, async (ctx, req) => {
  needUser(ctx);
  const body = await readBody(req);
  const r = CS.redeemPromo(ctx.key.user_id, String(body.code || ''));
  if (!r.ok) throw new ApiError(400, 'PROMO_REJECTED', r.message);
  return { data: r };
});

// ---------------------------------------------------------------- docs
function openapiSpec() {
  return {
    openapi: '3.0.3',
    info: { title: 'TelegramLisans Public API', version: '1.0.0', description: 'License store API. Keys + scopes + rate limits managed in the admin panel. Balance is shared with the Telegram bot.' },
    servers: [{ url: V.replace(/\/$/, '') }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'sk-…' } },
      headers: {
        RateLimitRemaining: { description: 'Weighted tokens left in your bucket' },
        RequestId: { description: 'Trace id, echoed in every error too' }
      }
    },
    paths: {
      '/health': { get: { summary: 'Liveness (no auth)', security: [] } },
      '/categories': { get: { summary: 'Active categories', 'x-scope': 'catalog:read', 'x-cost': 1 } },
      '/products': { get: { summary: 'Catalog with live prices (bound-user discounts apply)', 'x-scope': 'catalog:read', 'x-cost': 1, parameters: [{ name: 'category_id', in: 'query', schema: { type: 'integer' } }, { name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } }, { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }] } },
      '/products/{id}': { get: { summary: 'Product detail + service offers (warranty-filtered)', 'x-scope': 'catalog:read', 'x-cost': 2 } },
      '/locks': { post: { summary: 'Lock the current price for 10 minutes (mandatory for dynamic products)', 'x-scope': 'orders:write', 'x-cost': 2 } },
      '/orders': { get: { summary: 'Order list for bound account', 'x-scope': 'orders:read', 'x-cost': 1 }, post: { summary: 'Place order (balance payment; Idempotency-Key REQUIRED)', 'x-scope': 'orders:write', 'x-cost': 8 } },
      '/orders/{id}': { get: { summary: 'Order detail + delivered items', 'x-scope': 'orders:read', 'x-cost': 1 } },
      '/wallet': { get: { summary: 'Balance, purchases, promos', 'x-scope': 'wallet:read', 'x-cost': 1 } },
      '/wallet/transactions': { get: { summary: 'Wallet history', 'x-scope': 'wallet:read', 'x-cost': 1 } },
      '/wallet/promo': { post: { summary: 'Redeem promo code', 'x-scope': 'wallet:write', 'x-cost': 2 } }
    }
  };
}

function docsHtml() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>bot-api v1 docs</title>
<style>body{font-family:system-ui;max-width:960px;margin:32px auto;padding:0 16px;background:#0f1115;color:#e6e6e6}
code{background:#1d222b;padding:2px 6px;border-radius:4px}h2{margin-top:34px}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #2a3140;padding:8px;text-align:left;font-size:14px}th{background:#161b24}
.m{font-weight:700}.GET{color:#4ade80}.POST{color:#fbbf24}.del{color:#f87171}.badge{font-size:11px;border:1px solid #2a3140;border-radius:999px;padding:2px 8px}</style></head><body>
<h1>TelegramLisans API v1</h1>
<p>Base: <code>https://bot-api.developer.org.tr/v1/</code> · Auth: <code>Authorization: Bearer sk-…</code> (admin panel → API Keys).</p>
<h2>Rate limiting</h2>
<p>Token bucket per key (<code>X-RateLimit-*</code> headers), <b>weighted costs</b> per route below, daily quota when configured. 429 responses carry <code>Retry-After</code>. Write endpoints are additionally protected by the supplier rate governor — upstream bans are impossible by design.</p>
<h2>Idempotency</h2><p><code>POST /v1/orders</code> requires <code>Idempotency-Key</code>: replay returns the first result (24h window).</p>
<h2>Webhooks</h2><p>Per-key <code>webhook_url</code> receives <code>order.created</code> JSON, HMAC-SHA256 signed with the key's secret in <code>X-Api-Signature: sha256=&lt;hex&gt;</code>.</p>
<h2>Errors</h2><p>Uniform: <code>{ "error": { "code", "message", "request_id" } }</code> · codes: UNAUTHORIZED, FORBIDDEN_SCOPE, NO_ACCOUNT, VALIDATION, IDEMPOTENCY_REQUIRED, LOCK_REQUIRED, LOCK_EXPIRED, SERVICE_UNAVAILABLE, SOLD_OUT, NOT_FOUND, INSUFFICIENT_BALANCE, NOT_ENOUGH_STOCK, RATE_LIMITED, QUOTA_EXCEEDED, INTERNAL.</p>
<table><tr><th>Method</th><th>Endpoint</th><th>Scope</th><th>Cost</th><th>Description</th></tr>
${Object.entries(openapiSpec().paths).map(([p, ops]) => Object.entries(ops).map(([mth, o]) =>
  `<tr><td class="m ${mth.toUpperCase()}">${mth.toUpperCase()}</td><td><code>/v1${p}</code></td><td>${o['x-scope'] || 'public'}</td><td>${o['x-cost'] || 1}</td><td>${o.summary}</td></tr>`).join('')).join('')}
</table>
<p class="del">Remember: never put API keys in a URL — they leak into every log.</p>
</body></html>`;
}

// ---------------------------------------------------------------- utils
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return { en: s, tr: s }; } }
function safeJsonArr(s) { try { const j = JSON.parse(s || '[]'); return Array.isArray(j) ? j : []; } catch (e) { return []; } }

async function summaryCached(uid, product) {
  const ck = `${uid || 0}:${product.id}`;
  const hit = SUMMARY_CACHE.get(ck);
  if (hit && Date.now() - hit.at < SUM_TTL) return hit.data;
  const data = uid
    ? await CS.productSummary(uid, product)
    : { mode: product.pricing_mode || 'manual', unit: round2(product.price), stock: db.prepare('SELECT COUNT(*) c FROM stocks WHERE product_id=? AND is_sold=0').get(product.id).c, soldOut: false };
  SUMMARY_CACHE.set(ck, { at: Date.now(), data });
  if (SUMMARY_CACHE.size > 500) {
    const cut = Date.now() - SUM_TTL * 2;
    for (const [k, v] of SUMMARY_CACHE) if (v.at < cut) SUMMARY_CACHE.delete(k);
  }
  return data;
}

// ---------------------------------------------------------------- dispatcher
async function handleApi(req, res) {
  const rid = reqId();
  const t0 = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = clientIp(req);
  let ctx = null;
  let out = null;

  try {
    if (req.method === 'OPTIONS') { out = { status: 204, body: null }; return; }
    if (!url.pathname.startsWith(V)) {
      out = fail(404, 'NOT_FOUND', `unknown path — API base is ${V} (docs at ${V}docs)`, rid); return;
    }
    const path = url.pathname.slice(V.length);

    // Layer 1: per-IP flood guard (applies even to unauthenticated scans)
    const ipRes = registry.consume(`ip:${ip}`, IP_RPM, 1, null);
    if (!ipRes.allowed) {
      out = fail(429, 'RATE_LIMITED', 'per-IP flood limit exceeded', rid);
      out.rate = { limit: IP_RPM, remaining: 0, retryAfter: ipRes.retryAfter };
      out.headers = { 'Retry-After': String(ipRes.retryAfter) };
      return;
    }

    const rt = routes.find((r) => r.method === req.method && r.pattern.test(path));
    if (!rt) {
      if (path === 'openapi.json') { out = { status: 200, body: openapiSpec() }; return; }
      if (path === 'docs') { out = { status: 200, html: docsHtml() }; return; }
      if (path === '') { out = { status: 200, body: { service: 'license-bot-api', docs: `${V}docs`, openapi: `${V}openapi.json` } }; return; }
      out = fail(405, 'METHOD_NOT_ALLOWED', `${req.method} ${V}${path} not supported`, rid); return;
    }

    // openapi/docs already matched above only when no route — public endpoints:
    if (rt.scope) ctx = authenticate(req);

    // Layer 2+3: key bucket + daily quota
    let rate = null;
    if (ctx) {
      const rpm = ctx.key.rate_limit_per_min || API_DEFAULT_RPM;
      const r = registry.consume(`key:${ctx.key.id}`, rpm, rt.cost, ctx.key.daily_limit || null);
      rate = { limit: rpm, remaining: r.remaining, reset: r.retryAfter };
      if (!r.allowed) {
        out = fail(429, r.limitedBy === 'daily' ? 'QUOTA_EXCEEDED' : 'RATE_LIMITED',
          r.limitedBy === 'daily' ? 'daily request quota exhausted' : 'rate limit exceeded — slow down', rid);
        out.rate = Object.assign(rate, { retryAfter: r.retryAfter });
        return;
      }
      if (rt.scope) needScope(ctx, rt.scope);
    }

    const m = path.match(rt.pattern);
    const handlerOut = await rt.handler(ctx, req, res, url, m, rid);
    if (handlerOut && handlerOut.__replay) { out = { status: handlerOut.status, body: handlerOut.body, rate, replay: true }; return; }
    if (handlerOut && (handlerOut.status || handlerOut.body)) { out = { status: handlerOut.status || 200, body: handlerOut.body, rate }; return; }
    out = { status: 200, body: handlerOut && handlerOut.html ? null : handlerOut, rate };
    if (handlerOut && handlerOut.html) out.html = handlerOut.html;
  } catch (e) {
    if (e instanceof ApiError) {
      out = fail(e.status, e.code, e.message, rid);
    } else if (e instanceof CS.CheckoutError) {
      out = fail(409, String(e.code || 'CHECKOUT_FAILED').toUpperCase(), e.message, rid);
    } else {
      console.error('[api] unexpected:', e.stack || e.message);
      out = fail(500, 'INTERNAL', 'internal error (request_id logged for the operator)', rid);
      if (out) out.detail = e.message;
    }
  } finally {
    const status = (out && out.status) || 500;
    const ms = Date.now() - t0;
    // audit: errors, slow requests
    if (status >= 400 || ms > 1000) {
      audit({ rid, keyId: ctx && ctx.key.id, method: req.method, route: url.pathname, status, code: out && out.body && out.body.error && out.body.error.code, ip, ms, detail: out && out.detail });
    }
    const rateObj = out && out.rate ? { limit: out.rate.limit, remaining: out.rate.remaining, reset: out.rate.reset, retryAfter: out.rate.retryAfter } : {};
    if (out && out.html) {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'X-Request-Id': rid });
      res.end(out.html);
    } else {
      send(res, rid, status, out ? out.body : { error: { code: 'INTERNAL', message: 'empty response', request_id: rid } }, rateObj);
    }
  }
}

// ---------------------------------------------------------------- boot
function startApiServer() {
  if (!API_ENABLED) { console.log('[Api] devre dışı (API_ENABLED!=1)'); return null; }
  const server = http.createServer((req, res) => { handleApi(req, res); });
  server.setTimeout(30000);
  server.listen(API_PORT, '0.0.0.0', () => console.log(`[Api] REST v1 http://0.0.0.0:${API_PORT}${V} (docs: /v1/docs)`));
  // hourly housekeeping
  const t = setInterval(() => {
    const cut = Date.now() - IDEM_TTL_MS;
    for (const [k, v] of IDEMPOTENCY) if (v.at < cut) IDEMPOTENCY.delete(k);
    try { db.prepare("DELETE FROM api_log WHERE ts < datetime('now', '-14 days')").run(); } catch (e) {}
  }, 3600 * 1000);
  if (t.unref) t.unref();
  return server;
}

module.exports = { startApiServer, handleApi, hashKey, routes, registry, openapiSpec };
