/**
 * Web store — dependency-free HTTP server sharing the bot's brain.
 *
 * All pricing, warranty gating, stock masking, price locks and fulfilment
 * go through CheckoutService, so the web store and the Telegram bot are the
 * same shop: same prices, same discounts (rank/group/promo/bulk), same
 * balance, same order history.
 *
 * Auth model (same as the bot's Binance-Pay flow): the customer opens the
 * web app, "signs in" with their Telegram numeric ID (the one they use in
 * the bot) and a short-lived token is issued. There is no password — orders
 * and balances are tied to that ID, exactly like in the bot.
 *
 *   GET  /                → store page (SPA, static from /web/public)
 *   GET  /api/config      → languages, categories
 *   POST /api/login       { user_id }                → { token }
 *   GET  /api/me          (auth)                     → profile + balance + orders
 *   GET  /api/products    (auth)                     → categories + summaries
 *   GET  /api/product/:id (auth)                     → detail + dynamic service list
 *   POST /api/lock        (auth) { product_id, ps_id|best }   → price lock + quote
 *   POST /api/checkout    (auth) { lock_token|product_id, qty, pay: 'balance'|'binance', txid? }
 *   GET  /api/orders      (auth)                     → order + reservation history
 *   GET  /admin/health    (ADMIN token)              → suppliers stock/balance info
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');
const CS = require('../src/services/CheckoutService');
const { t } = require('../src/utils/i18n');
const { parseQuantity, parseMoney } = require('../src/utils/money');
const { checkTransaction } = require('../src/services/binance');
const { WEB_PORT, WEB_ENABLED, ADMIN_ID, BOT_TOKEN, BOT_USERNAME } = require('../src/config/env');
const { handleAdmin } = require('./admin');
const DepSvc = require('../src/services/DepositProviders');

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
const SESSIONS = new Map(); // token -> { user_id, expires }
const IDEMPOTENCY = new Map(); // key -> { at, result }

/**
 * Telegram Login Widget verification (official algorithm):
 * data_check_string = sorted key=value lines joined with \n (hash excluded);
 * secret = SHA256(BOT_TOKEN); expect HMAC-SHA256(secret, dcs) === hash.
 * Rejects stale auth (>1 day) and forged identities — the web store shares
 * real balances, so this is the only acceptable login path.
 */
function verifyTelegramLogin(p) {
  if (!BOT_TOKEN) return { ok: false, error: 'bot token yok' };
  const { hash, auth_date, id } = p;
  if (!hash || !auth_date || !id) return { ok: false, error: 'eksik alan' };
  if (Number(auth_date) && Date.now() / 1000 - Number(auth_date) > 86400) {
    return { ok: false, error: 'giriş bağlantısı eskimiş, tekrar dene' };
  }
  const dcs = Object.keys(p)
    .filter((k) => k !== 'hash' && p[k] !== undefined && p[k] !== '')
    .sort()
    .map((k) => `${k}=${p[k]}`)
    .join('\n');
  const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(hash), 'hex'))) {
      return { ok: false, error: 'imza geçersiz' };
    }
  } catch (e) {
    return { ok: false, error: 'imza bozuk' };
  }
  return { ok: true, user: { id: Number(id), username: p.username || null, first_name: p.first_name || '' } };
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too big')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function auth(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s || s.expires < Date.now()) { SESSIONS.delete(token); return null; }
  s.expires = Date.now() + TOKEN_TTL_MS; // sliding
  return s;
}

function ensureUser(userId) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (row) return row;
  db.prepare('INSERT INTO users (id, balance, lang) VALUES (?, 0, ?)').run(userId, 'en');
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function publicProduct(p, lang) {
  return {
    id: p.id,
    name: CS.localized(p, lang),
    description: (() => {
      try { const j = JSON.parse(p.description || '{}'); return j[lang] || j.en || j.tr || ''; }
      catch (e) { return p.description || ''; }
    })(),
    warranty: p.warranty || 'none'
  };
}

/** Raw-text body reader — provider IPN signatures verify over raw bytes. */
function readRaw(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('ipn body too big')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * /ipn/nowpayments + /ipn/coinpayments — provider payment webhooks.
 * Verified by HMAC over the raw body; crediting is idempotent inside
 * DepositProviders (deposit_events UNIQUE(provider,ref)).
 */
async function handleIpn(req, res, url) {
  const isNp = url.pathname === '/ipn/nowpayments';
  let raw = '';
  try { raw = await readRaw(req); } catch (e) { return json(res, 400, { error: 'body' }); }
  const sig = String(req.headers[isNp ? 'x-nowpayments-sig' : 'x-coinpay-signature'] || '');
  const ok = isNp ? DepSvc.verifyNpSignature(raw, sig) : DepSvc.verifyCpSignature(raw, sig);
  if (!ok) {
    console.warn(`[ipn:${isNp ? 'np' : 'cp'}] BAD SIGNATURE from ${req.socket.remoteAddress}`);
    return json(res, 401, { error: 'invalid signature' });
  }
  let body = null;
  try {
    body = isNp ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
  } catch (e) { return json(res, 400, { error: 'bad payload' }); }
  try {
    const r = isNp
      ? await DepSvc.handleNpIpn(body, global.__LICENSE_BOT)
      : await DepSvc.handleCpIpn(body, global.__LICENSE_BOT);
    console.log(`[ipn:${isNp ? 'np' : 'cp'}]`, JSON.stringify(r).slice(0, 200));
  } catch (e) { console.error('[ipn] handler error:', e.message); }
  return json(res, 200, { ok: true }); // 200 even when ignored — stop provider retries
}

async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const route = seg.slice(1).join('/');

  // ---- provider IPN webhooks (public, signature-verified) ----
  if (url.pathname === '/ipn/nowpayments' || url.pathname === '/ipn/coinpayments') {
    return handleIpn(req, res, url);
  }

  // ---- admin panel surface (same widget session, ADMIN_ID only) ----
  if (url.pathname.startsWith('/api/admin/')) {
    const asess = auth(req);
    return handleAdmin(req, res, url, asess);
  }

  // ---- login (no auth) ----
  if (route === 'config') {
    const langs = db.prepare('SELECT code, native_name, flag FROM languages WHERE enabled = 1 ORDER BY sort_order').all();
    const cats = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order').all()
      .map((c) => {
        let name = c.slug;
        try { const j = JSON.parse(c.name_json); name = j.en || j.tr || c.slug; } catch (e) {}
        return { id: c.id, name, emoji: c.emoji };
      });
    let botUsername = BOT_USERNAME || null;
    try {
      if (!botUsername && !startWebServer._me) {
        const bot = global.__LICENSE_BOT;
        if (bot && bot.telegram) startWebServer._me = bot.telegram.getMe().then((m) => m.username || null).catch(() => null);
      }
      if (!botUsername) {
        botUsername = await startWebServer._me || null;
        if (!botUsername) startWebServer._me = null; // allow a later retry after startup/network errors
      }
    } catch (e) {}
    return json(res, 200, { languages: langs, categories: cats, currency: 'USD', bot_username: botUsername, crypto_deposits: DepSvc.providerConfigured() });
  }

  if (route === 'login' && req.method === 'POST') {
    const body = await readBody(req);
    const v = verifyTelegramLogin(body || {});
    if (!v.ok) return json(res, 401, { error: v.error || 'doğrulama başarısız' });
    const user = ensureUser(v.user.id);
    if (v.user.username && !user.username) {
      try { db.prepare('UPDATE users SET username = ? WHERE id = ?').run(v.user.username, user.id); } catch (e) {}
    }
    const token = crypto.randomBytes(24).toString('hex');
    SESSIONS.set(token, { user_id: user.id, expires: Date.now() + TOKEN_TTL_MS });
    return json(res, 200, { token, name: user.username || String(user.id), balance: round2(user.balance || 0) });
  }

  // ---- everything below needs auth, EXCEPT the browse endpoints (guests
  // see base prices; discounts need a signed-in Telegram account) ----
  const browsePublic = route === 'products' || /^product\/\d+$/.test(route);
  const sess = auth(req);
  if (!sess) {
    if (browsePublic) return handleBrowse(req, res, route, url);
    return json(res, 401, { error: 'unauthorized' });
  }
  const userId = sess.user_id;
  const user = ensureUser(userId);
  const lang = CS.getUserLang(userId) === 'tr' ? 'tr' : (req.headers['x-lang'] || user.lang || 'en');

  async function handleBrowse(req, res, route, url, userIdOrNull) {
    const uid = userIdOrNull !== undefined ? userIdOrNull : (sess ? sess.user_id : null);
    const blang = uid ? (req.headers['x-lang'] || CS.getUserLang(uid) || 'en') : (req.headers['x-lang'] || 'tr');
    if (route === 'products') {
      const products = db.prepare('SELECT * FROM products WHERE is_active = 1').all();
      const catRows = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order').all();
      const assign = db.prepare('SELECT * FROM product_categories').all();
      const byCat = new Map();
      for (const a of assign) {
        if (!byCat.has(a.category_id)) byCat.set(a.category_id, []);
        byCat.get(a.category_id).push(a.product_id);
      }
      const summaries = new Map();
      for (const p of products) {
        try {
          summaries.set(p.id, uid ? await CS.productSummary(uid, p)
            : { mode: p.pricing_mode || 'manual', unit: round2(p.price), stock: db.prepare('SELECT COUNT(*) c FROM stocks WHERE product_id=? AND is_sold=0').get(p.id).c, soldOut: false, name: CS.localized(p, blang) });
        } catch (e) { summaries.set(p.id, { mode: 'manual', unit: round2(p.price), stock: 0, soldOut: true }); }
      }
      const out = {
        products: products.map((p) => ({
          ...publicProduct(p, blang),
          price: summaries.get(p.id).unit,
          stock: summaries.get(p.id).stock,
           sold_out: !!summaries.get(p.id).soldOut,
           reservation_only: !!summaries.get(p.id).reservationOnly,
          pricing_mode: summaries.get(p.id).mode
        }))
      };
      out.categories = catRows.map((c) => {
        let name = c.slug;
        try { const j = JSON.parse(c.name_json); name = j.tr || j.en || c.slug; } catch (e) {}
        return { id: c.id, name, emoji: c.emoji, product_ids: byCat.get(c.id) || [] };
      });
      return json(res, 200, out);
    }
    const mProd = route.match(/^product\/(\d+)$/);
    if (mProd) {
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(Number(mProd[1]));
      if (!product) return json(res, 404, { error: 'product not found' });
      const summary = uid ? await CS.productSummary(uid, product) : null;
      const body = {
        product: publicProduct(product, blang),
         summary: summary ? { price: summary.unit, stock: summary.stock, sold_out: summary.soldOut, reservation_only: !!summary.reservationOnly, mode: summary.mode } :
          { price: round2(product.price), stock: db.prepare('SELECT COUNT(*) c FROM stocks WHERE product_id=? AND is_sold=0').get(product.id).c, sold_out: false, mode: product.pricing_mode || 'manual' }
      };
      if (summary && summary.decision) {
        body.services = CS.serviceLines(product, summary.decision, blang, uid).map((s) => ({
          index: s.index, ps_id: s.psId, name: s.name, price: s.sellUnit,
           stock: s.stock, affordable: s.affordable, best: s.best, warranty: s.warranty,
           reservation_only: !!s.reservationOnly
        }));
      }
      return json(res, 200, body);
    }
    return json(res, 404, { error: 'not found' });
  }

  if (route === 'logout' && req.method === 'POST') {
    for (const [tk, s] of SESSIONS) if (s.user_id === userId) SESSIONS.delete(tk);
    return json(res, 200, { ok: true });
  }

  if (route === 'promo' && req.method === 'POST') {
    const body = await readBody(req);
    const r = CS.redeemPromo(userId, String(body.code || ''));
    const fresh = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
    return json(res, r.ok ? 200 : 400, {
      ok: r.ok, message: r.message,
      balance: round2((fresh && fresh.balance) || 0)
    });
  }

  if (route === 'me') {
    return json(res, 200, {
      id: user.id,
      username: user.username || null,
      balance: round2(user.balance || 0),
      total_purchases: user.total_purchases || 0,
      lang,
      is_admin: user.id === ADMIN_ID
    });
  }

  // ---- multi-network crypto deposits ("kişiye özel cüzdan") ----
  if (route === 'deposits' && req.method === 'GET') {
    if (!DepSvc.providerConfigured()) return json(res, 200, { enabled: false, data: [] });
    const rows = DepSvc.listUserWallets(userId);
    return json(res, 200, {
      enabled: true, provider: DepSvc.provider,
      networks: DepSvc.enabledNetworks().map((n) => ({ key: n.key, label: n.label, icon: n.icon })),
      data: rows.map((w) => ({ network: w.network, label: DepSvc.networkLabel(w.network), address: w.address, memo: w.address_extra || null, url: w.label || null }))
    });
  }
  if (route === 'deposits' && req.method === 'POST') {
    if (!DepSvc.providerConfigured()) return json(res, 400, { error: 'kripto yatırma devre dışı' });
    const body = await readBody(req);
    try {
      const w = await DepSvc.getDepositWallet(userId, String(body.network || ''));
      return json(res, 200, {
        network: w.network, label: DepSvc.networkLabel(w.network),
        address: w.address, memo: w.address_extra || null, url: w.label || null
      });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (route === 'products' || /^product\/\d+$/.test(route)) {
    return handleBrowse(req, res, route, url, userId);
  }

  if (route === 'lock' && req.method === 'POST') {
    const body = await readBody(req);
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(Number(body.product_id));
    if (!product) return json(res, 404, { error: 'product not found' });
    const mode = product.pricing_mode || 'manual';
    // The lock stores the BASE offer unit (exactly like the bot's session
    // baseUnitPrice); customer discounts are applied once at checkout by
    // calculateTotalPrice — never baked into the lock.
    if (mode === 'manual') {
      const token = CS.issuePriceLock(product, null, round2(product.price));
      return json(res, 200, { token, unit: round2(CS.getUserUnitPrice(userId, product)), mode });
    }
    const decision = await CS.productDecision(product, 1);
    if (!decision) return json(res, 500, { error: 'pricing unavailable' });
    let offer = null;
    if (body.ps_id) {
       offer = decision.all.find((o) => o.product_supplier_id === Number(body.ps_id) &&
         (o.affordable || decision.reservable.includes(o)) && o.reason !== 'warranty_mismatch');
    } else {
      offer = decision.priceOffer;
    }
    if (!offer) return json(res, 409, { error: 'offer no longer available' });
    const token = CS.issuePriceLock(product, offer, offer.sellUnit);
    return json(res, 200, {
      token,
      unit: round2(CS.getUserUnitPrice(userId, product, offer.sellUnit)),
      mode,
      ps_id: offer.product_supplier_id
    });
  }

  if (route === 'checkout' && req.method === 'POST') {
    // idempotency: same key within 15 min returns the original result
    const idem = req.headers['idempotency-key'] || null;
    if (idem) {
      const hit = IDEMPOTENCY.get(idem);
      if (hit && Date.now() - hit.at < 15 * 60 * 1000) return json(res, 200, hit.result);
    }

    const body = await readBody(req);
    const qty = parseQuantity(String(body.qty));
    if (isNaN(qty) || qty <= 0 || qty > 10000) return json(res, 400, { error: 'geçersiz adet' });
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(Number(body.product_id));
    if (!product) return json(res, 404, { error: 'product not found' });

    const lock = CS.readPriceLock(body.lock_token);
    const unitBase = lock && lock.product_id === product.id ? lock.unit_price : null;
    if (body.lock_token && !unitBase) return json(res, 410, { error: 'fiyat kilidi doldu, yenile' });

    const total = round2(CS.calculateTotalPrice(userId, product, qty, unitBase));
    const pay = body.pay || 'balance';

    const txid = `WEB_${userId}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    let result;
    try {
      if (pay === 'balance') {
        const bal = round2(user.balance || 0);
        if (bal < total) return json(res, 402, { error: `bakiye yetersiz (bakiye: ${bal}$, gereken: ${total}$). Rezervasyon için önce bakiye yükleyin.` });
        db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(total, userId);
        try {
          result = await CS.fulfill(userId, product, qty, {
            paidAmount: total,
            unitBase,
            chosenPs: lock ? lock.psId : null,
            txid,
            isReservation: !!body.reserve,
            trueMissing: body.reserve ? qty : undefined,
            source: 'web'
          });
        } catch (e) {
          db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(total, userId); // refund on failure
          throw e;
        }
      } else if (pay === 'binance') {
        const givenTx = String(body.txid || '').trim();
        if (!givenTx) return json(res, 400, { error: 'txid gerekli' });
        const existing = db.prepare('SELECT 1 FROM transactions WHERE txid = ?').get(givenTx);
        if (existing) return json(res, 409, { error: 'bu txid zaten kullanılmış' });
        const info = await checkTransaction(givenTx);
        if (!info || info.status !== 'SUCCESS') {
          // not settled yet — the shared DepositPoller credits automatically
          db.prepare(`INSERT OR IGNORE INTO pending_topups (user_id, txid, expected_amount, product_id, qty, source, note)
                      VALUES (?,?,?,?,?,?,?)`)
            .run(userId, givenTx, total, product.id, qty, 'web', 'unverified at submit');
          return json(res, 200, {
            ok: true, kind: 'queued', paid: total,
            message: 'Ödemen henüz sonuçlanmadı — BEKLEYEN YATIRMA olarak kaydedildi. Binance onaylayınca tutar otomatik olarak bakiyene yüklenecek ve bot sana mesaj atacak. Sipariş numarasını tekrar göndermene gerek yok.'
          });
        }
        if (info.amount < total) {
          // confirmed but short — credit exactly what was paid
          const paidIn = round2(info.amount);
          const { getUsdTryRate } = require('../src/utils/currency');
          const tryRate = await getUsdTryRate().catch(() => 47.22);
          db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(paidIn, userId);
          db.prepare('INSERT INTO transactions (txid, user_id, product_id, amount, status, amount_try) VALUES (?,?,?,?,?,?)')
            .run(givenTx, userId, product.id, paidIn, 'SUCCESS', paidIn * tryRate);
          const nb = round2(db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance);
          return json(res, 200, {
            ok: true, kind: 'topped_up', paid: paidIn, balance: nb,
            message: `Gönderilen tutar eksikti (${paidIn}$ / gereken ${total}$). Gönderdiğin tutar bakiyene yüklendi (yeni bakiye: ${nb}$). Siparişi bakiye ile tamamlayabilirsin.`
          });
        }
        result = await CS.fulfill(userId, product, qty, {
          paidAmount: total, unitBase,
          chosenPs: lock ? lock.psId : null,
          txid: givenTx, isReservation: !!body.reserve, source: 'web'
        });
      } else {
        return json(res, 400, { error: 'bilinmeyen ödeme tipi' });
      }
    } catch (e) {
      if (e instanceof CS.CheckoutError) return json(res, 409, { error: e.message, code: e.code });
      console.error('[web] checkout error:', e.message);
      return json(res, 500, { error: 'sistem hatası, yönetici bilgilendirildi' });
    }

    const out = {
      ok: true,
      kind: result.kind,
      qty: result.qty,
      paid: total,
      delivered: result.kind === 'delivered' ? result.delivered : null,
      txid
    };
    if (idem) IDEMPOTENCY.set(idem, { at: Date.now(), result: out });
    notifyTelegramAdmin(product, qty, total, 'web');
    return json(res, 200, out);
  }

  if (route === 'orders') {
    const orders = db.prepare(`
      SELECT o.id, o.qty, o.sell_usd, o.profit_usd, o.created_at, o.status, o.delivered_data,
             p.name AS product_name
      FROM orders o LEFT JOIN products p ON p.id = o.product_id
      WHERE o.user_id = ? AND (o.status IS NULL OR o.status != 'cancelled')
      ORDER BY o.id DESC LIMIT 50
    `).all(userId).map((o) => {
      let pname = o.product_name;
      try { pname = CS.localized({ name: o.product_name }, lang); } catch (e) {}
      let items = [];
      try { items = JSON.parse(o.delivered_data || '[]'); } catch (e) {}
      return {
        id: o.id, product: pname, qty: o.qty, paid: round2(o.sell_usd),
        date: o.created_at, status: o.status || 'delivered', delivered: items
      };
    });
    const reservations = db.prepare(`
      SELECT r.id, r.qty, r.fulfilled_qty, r.sell_usd, r.status, r.created_at, p.name AS product_name
      FROM reservations r LEFT JOIN products p ON p.id = r.product_id
      WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 20
    `).all(userId).map((r) => ({
      id: r.id, product: CS.localized({ name: r.product_name }, lang), qty: r.qty,
      fulfilled: r.fulfilled_qty, paid: round2(r.sell_usd), status: r.status, date: r.created_at
    }));
    return json(res, 200, { orders, reservations });
  }

  return json(res, 404, { error: 'not found' });
}

function notifyTelegramAdmin(product, qty, total, source) {
  try {
    const bot = global.__LICENSE_BOT; // set by src/bot.js when running in-process
    if (bot && bot.telegram && ADMIN_ID) {
      bot.telegram.sendMessage(ADMIN_ID,
        `🌐 <b>Web siparişi</b>\n${CS.localized(product, 'en')} × ${qty}\n💰 $${round2(total)}`, { parse_mode: 'HTML' })
        .catch(() => {});
    }
  } catch (e) { /* bot not loaded in this context */ }
}

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// ---------------------------------------------------------------- static

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
function serveStatic(req, res, url) {
  const pub = path.join(__dirname, 'public');
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  if (url.pathname === '/admin') file = '/admin.html';
  file = path.normalize(file).replace(/\\/g, '/');
  const full = path.join(pub, file);
  if (!full.startsWith(pub)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(pub, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(full)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(data);
  });
}

function startWebServer() {
  if (!WEB_ENABLED) { console.log('[Web] devre dışı (WEB_ENABLED!=1)'); return null; }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ipn/')) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      console.error('[Web] error:', e.message);
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    }
  });
  const port = WEB_PORT || 3000;
  server.listen(port, () => console.log(`[Web] mağaza http://0.0.0.0:${port}`));
  return server;
}

module.exports = { startWebServer };
