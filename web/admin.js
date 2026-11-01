/**
 * Web ADMIN panel backend — /api/admin/* on the shop server.
 *
 * Auth: the SAME Telegram widget session as the shop, but the account must
 * be ADMIN_ID. No new auth system, no shared secrets. Every mutation mirrors
 * a capability that already exists in the bot's admin UI (this is a panel,
 * not a second brain) and goes through the same services (PricingEngine,
 * CatalogStore, CatalogMatcher, CheckoutService) so rules can't diverge.
 *
 * Negative balances are allowed by design (cari hesabı).
 */
const crypto = require('crypto');
const { db } = require('../src/db');
const CS = require('../src/services/CheckoutService');
const CatalogStore = require('../src/services/CatalogStore');
const { PricingEngine } = require('../src/services/PricingEngine');
const CatalogMatcher = require('../src/services/CatalogMatcher');
const { classifyWarranty, LABELS: W_LABELS } = require('../src/utils/warranty');
const { parseMoney } = require('../src/utils/money');
const { ADMIN_ID } = require('../src/config/env');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 256 * 1024) { reject(new Error('body too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Error('invalid json')); } });
    req.on('error', reject);
  });
}
const num = (v, def) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? def : Number(v));

// ---------------------------------------------------------------- keys
function generateApiKey(name, opts, actorId) {
  const raw = 'sk-' + crypto.randomBytes(24).toString('hex');
  const scopes = Array.isArray(opts.scopes) && opts.scopes.length ? opts.scopes : ['catalog:read', 'orders:read', 'orders:write'];
  const webhookSecret = opts.webhook_url ? crypto.randomBytes(16).toString('hex') : null;
  const r = db.prepare(`INSERT INTO api_keys (name, key_hash, key_preview, scopes, rate_limit_per_min, daily_limit, user_id, webhook_url, webhook_secret, created_by)
                        VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(name, crypto.createHash('sha256').update(raw).digest('hex'), raw.slice(0, 11),
      JSON.stringify(scopes), num(opts.rate_limit_per_min, 120), num(opts.daily_limit, null),
      num(opts.user_id, null), opts.webhook_url || null, webhookSecret, actorId);
  return { id: r.lastInsertRowid, raw_key: raw, webhook_secret: webhookSecret };
}

// ---------------------------------------------------------------- router
async function handleAdmin(req, res, url, sess) {
  if (!sess) return json(res, 401, { error: 'unauthorized' });
  if (sess.user_id !== ADMIN_ID) return json(res, 403, { error: 'admin değil' });

  const route = url.pathname.replace(/^\/api\/admin\//, '');
  const seg = route.split('/');
  const M = req.method;
  const body = (M === 'POST' || M === 'PATCH') ? await readBody(req) : {};

  // ---- dashboard stats ----
  if (M === 'GET' && route === 'stats') {
    const today = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(sell_usd),0) s, COALESCE(SUM(profit_usd),0) p FROM orders WHERE created_at >= date('now')").get();
    const total = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(sell_usd),0) s, COALESCE(SUM(profit_usd),0) p FROM orders').get();
    const week = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(sell_usd),0) s, COALESCE(SUM(profit_usd),0) p FROM orders WHERE created_at >= datetime('now','-7 days')").get();
    const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    const negBal = db.prepare('SELECT COUNT(*) c FROM users WHERE balance < 0').get().c;
    const reservations = db.prepare("SELECT COUNT(*) c FROM reservations WHERE status='PENDING'").get().c;
    const matches = db.prepare("SELECT COUNT(*) c FROM product_matches WHERE status='pending'").get().c;
    const topups = db.prepare("SELECT COUNT(*) c FROM pending_topups WHERE status='PENDING'").get().c;
    const api = db.prepare("SELECT COUNT(*) c FROM api_log WHERE ts >= datetime('now','-1 day')").get().c;
    const apiErr = db.prepare("SELECT COUNT(*) c FROM api_log WHERE ts >= datetime('now','-1 day') AND status >= 400").get().c;
    const top = db.prepare(`SELECT product_id, COUNT(*) o, SUM(sell_usd) s FROM orders WHERE created_at >= datetime('now','-7 days') GROUP BY product_id ORDER BY s DESC LIMIT 5`).all()
      .map((r) => { const p = db.prepare('SELECT name FROM products WHERE id=?').get(r.product_id); return { product: p ? CS.localized({ name: p.name }, 'tr') : r.product_id, orders: r.o, sales: round2(r.s) }; });
    return json(res, 200, {
      today: { orders: today.c, sales: round2(today.s), profit: round2(today.p) },
      week: { orders: week.c, sales: round2(week.s), profit: round2(week.p) },
      all: { orders: total.c, sales: round2(total.s), profit: round2(total.p) },
      users, negative_balances: negBal, pending_reservations: reservations, pending_matches: matches,
      pending_topups: topups,
      api: { requests_24h: api, errors_24h: apiErr }, top_products: top
    });
  }

  // ---- orders ----
  if (M === 'GET' && route === 'orders') {
    const limit = Math.min(200, num(url.searchParams.get('limit'), 50));
    const offset = Math.max(0, num(url.searchParams.get('offset'), 0));
    const q = url.searchParams.get('q') || '';
    let rows;
    if (/^\d+$/.test(q)) {
      rows = db.prepare(`SELECT o.*, p.name pn, u.username FROM orders o LEFT JOIN products p ON p.id=o.product_id LEFT JOIN users u ON u.id=o.user_id WHERE o.user_id = ? OR o.id = ? ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(Number(q), Number(q), limit, offset);
    } else {
      rows = db.prepare(`SELECT o.*, p.name pn, u.username FROM orders o LEFT JOIN products p ON p.id=o.product_id LEFT JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(limit, offset);
    }
    return json(res, 200, { data: rows.map((o) => ({ id: o.id, user: o.user_id, username: o.username, product: CS.localized({ name: o.pn }, 'tr'), qty: o.qty, paid: round2(o.sell_usd), profit: round2(o.profit_usd), status: o.status || 'completed', date: o.created_at, delivered: (() => { try { return JSON.parse(o.delivered_data || '[]'); } catch (e) { return []; } })(), source: (o.external_order_id || '').startsWith('dryrun') ? 'dry' : null })) });
  }

  // ---- users ----
  if (M === 'GET' && route === 'users') {
    const q = String(url.searchParams.get('q') || '').trim();
    let rows;
    if (!q) rows = db.prepare('SELECT id, username, first_name, balance, total_purchases FROM users ORDER BY id DESC LIMIT 30').all();
    else if (/^\d+$/.test(q.replace(/^@/, ''))) rows = db.prepare('SELECT id, username, first_name, balance, total_purchases FROM users WHERE id = ?').all(Number(q));
    else rows = db.prepare('SELECT id, username, first_name, balance, total_purchases FROM users WHERE username = ? COLLATE NOCASE OR username LIKE ?').all(q.replace(/^@/, ''), `%${q.replace(/^@/, '')}%`);
    return json(res, 200, { data: rows.map((u) => ({ ...u, balance: round2(u.balance || 0) })) });
  }
  let m = route.match(/^users\/(\d+)\/balance$/);
  if (M === 'POST' && m) {
    const uid = Number(m[1]);
    const amount = parseMoney(String(body.amount == null ? '' : body.amount));
    if (amount === null || amount === 0) return json(res, 400, { error: 'geçerli tutar gir (örn 10, 5.5, -10)' });
    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid);
    if (!user) return json(res, 404, { error: 'kullanıcı yok' });
    const next = round2((user.balance || 0) + amount);
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(next, uid);
    try {
      const { sendWalletTopUpLog } = require('../src/utils/logger');
      const bot = global.__LICENSE_BOT;
      if (bot && bot.telegram) sendWalletTopUpLog(bot.telegram, uid, amount);
    } catch (e) {}
    return json(res, 200, { ok: true, user_id: uid, amount, new_balance: next });
  }

  // ---- products ----
  if (M === 'GET' && route === 'products') {
    const rows = db.prepare('SELECT * FROM products ORDER BY id').all();
    return json(res, 200, { data: rows.map((p) => {
      const links = db.prepare('SELECT COUNT(*) c FROM product_suppliers WHERE product_id=? AND enabled=1').get(p.id).c;
      return {
        id: p.id, name: CS.localized(p, 'tr'), warranty: p.warranty || 'none',
        pricing_mode: p.pricing_mode || 'manual', price: round2(p.price), margin: p.default_margin_percent, floor: p.default_floor_price,
        active: !!p.is_active, links, selection_mode: p.supplier_selection_mode || 'cheapest'
      };
    }) });
  }
  m = route.match(/^products\/(\d+)$/);
  if (M === 'PATCH' && m) {
    const pid = Number(m[1]);
    if (!db.prepare('SELECT id FROM products WHERE id=?').get(pid)) return json(res, 404, { error: 'ürün yok' });
    const fields = [];
    const set = [];
    if (body.is_active !== undefined) { fields.push('is_active'); set.push(body.is_active ? 1 : 0); }
    if (body.price !== undefined) { fields.push('price'); set.push(num(body.price, null)); }
    if (body.warranty !== undefined) { fields.push('warranty'); set.push(['none', 'guaranteed', 'instant'].includes(body.warranty) ? body.warranty : 'none'); }
    if (body.pricing_mode !== undefined) { fields.push('pricing_mode'); set.push(['manual', 'max_profit', 'cheapest'].includes(body.pricing_mode) ? body.pricing_mode : 'manual'); }
    if (body.default_margin_percent !== undefined) { fields.push('default_margin_percent'); set.push(num(body.default_margin_percent, 0)); }
    if (body.default_floor_price !== undefined) { fields.push('default_floor_price'); set.push(num(body.default_floor_price, 0)); }
    if (body.supplier_selection_mode !== undefined) { fields.push('supplier_selection_mode'); set.push(body.supplier_selection_mode === 'priority' ? 'priority' : 'cheapest'); }
    if (!fields.length) return json(res, 400, { error: 'güncellenecek alan yok' });
    db.prepare(`UPDATE products SET ${fields.map((f) => `${f}=?`).join(',')} WHERE id=?`).run(...set, pid);
    return json(res, 200, { ok: true });
  }
  m = route.match(/^products\/(\d+)\/offers$/);
  if (M === 'GET' && m) {
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(Number(m[1]));
    if (!product) return json(res, 404, { error: 'ürün yok' });
    const decision = await PricingEngine.price(product, { qty: 1 });
    return json(res, 200, {
      product_id: product.id, mode: product.pricing_mode || 'manual', warranty: product.warranty || 'none',
      sold_out: !!decision.soldOut, display_unit: decision.displayUnit,
      services: decision.all.map((o) => ({
        service_id: o.product_supplier_id, supplier: o.supplier.name, name: o.remote_name,
        cost: o.unitCost, sell: o.sellUnit, stock: o.realStock, warranty_class: o.warranty,
        affordable: !!o.affordable, reason: o.reason
      }))
    });
  }
  m = route.match(/^products\/(\d+)\/links$/);
  if (M === 'GET' && m) {
    const rows = db.prepare(`SELECT ps.*, s.name sname FROM product_suppliers ps JOIN suppliers s ON s.id=ps.supplier_id WHERE ps.product_id=? ORDER BY ps.priority`).all(Number(m[1]));
    return json(res, 200, { data: rows.map((l) => ({ id: l.id, supplier_id: l.supplier_id, supplier: l.sname, remote_service_id: l.remote_service_id, priority: l.priority, margin: l.margin_percent, floor: l.floor_price, warranty: l.warranty || 'auto', enabled: !!l.enabled, last_price: l.last_price_usd, last_stock: l.last_stock })) });
  }
  if (M === 'POST' && m) {
    const pid = Number(m[1]);
    const { supplier_id, remote_service_id } = body;
    if (!supplier_id || !remote_service_id) return json(res, 400, { error: 'supplier_id ve remote_service_id gerekli' });
    const sup = db.prepare('SELECT id FROM suppliers WHERE id=?').get(Number(supplier_id));
    if (!sup) return json(res, 404, { error: 'tedarikçi yok' });
    const exists = db.prepare('SELECT id FROM product_suppliers WHERE product_id=? AND supplier_id=? AND remote_service_id=?').get(pid, Number(supplier_id), String(remote_service_id));
    if (exists) return json(res, 409, { error: 'bu bağlantı zaten var', id: exists.id });
    const maxP = db.prepare('SELECT COALESCE(MAX(priority),0) p FROM product_suppliers WHERE product_id=?').get(pid).p;
    const r = db.prepare(`INSERT INTO product_suppliers (product_id, supplier_id, remote_service_id, priority, margin_percent, floor_price, warranty)
                          VALUES (?,?,?,?,?,?,?)`)
      .run(pid, Number(supplier_id), String(remote_service_id), maxP + 1,
        num(body.margin_percent, null), num(body.floor_price, null), ['auto', 'guaranteed', 'instant', 'mixed'].includes(body.warranty) ? body.warranty : 'auto');
    // keep the catalog snapshot row alive for the linked service
    db.prepare("UPDATE product_matches SET product_id=?, status='approved', decided_by=?, updated_at=CURRENT_TIMESTAMP WHERE supplier_id=? AND remote_service_id=?")
      .run(pid, ADMIN_ID, Number(supplier_id), String(remote_service_id));
    return json(res, 201, { ok: true, id: r.lastInsertRowid });
  }
  m = route.match(/^links\/(\d+)$/);
  if (M === 'PATCH' && m) {
    const ps = db.prepare('SELECT * FROM product_suppliers WHERE id=?').get(Number(m[1]));
    if (!ps) return json(res, 404, { error: 'bağlantı yok' });
    const fields = []; const set = [];
    if (body.enabled !== undefined) { fields.push('enabled'); set.push(body.enabled ? 1 : 0); }
    if (body.priority !== undefined) { fields.push('priority'); set.push(num(body.priority, ps.priority)); }
    if (body.margin_percent !== undefined) { fields.push('margin_percent'); set.push(num(body.margin_percent, null)); }
    if (body.floor_price !== undefined) { fields.push('floor_price'); set.push(num(body.floor_price, null)); }
    if (body.warranty !== undefined) { fields.push('warranty'); set.push(['auto', 'guaranteed', 'instant', 'mixed'].includes(body.warranty) ? body.warranty : 'auto'); }
    if (!fields.length) return json(res, 400, { error: 'alan yok' });
    db.prepare(`UPDATE product_suppliers SET ${fields.map((f) => `${f}=?`).join(',')} WHERE id=?`).run(...set, ps.id);
    return json(res, 200, { ok: true });
  }
  if (M === 'DELETE' && m) {
    db.prepare('DELETE FROM product_suppliers WHERE id=?').run(Number(m[1]));
    return json(res, 200, { ok: true });
  }

  // ---- suppliers + catalog browsing ----
  if (M === 'GET' && route === 'suppliers') {
    const rows = db.prepare('SELECT id, name, type, enabled FROM suppliers ORDER BY id').all();
    const out = [];
    for (const s of rows) {
      const snap = db.prepare('SELECT COUNT(*) c, SUM(COALESCE(stock,0)) st FROM supplier_catalogs WHERE supplier_id=?').get(s.id);
      out.push({ id: s.id, name: s.name, type: s.type, enabled: !!s.enabled, catalog_rows: snap.c, stock_sum: snap.st || 0 });
    }
    return json(res, 200, { data: out });
  }
  m = route.match(/^catalog\/(\d+)$/);
  if (M === 'GET' && m) {
    const sup = db.prepare('SELECT * FROM suppliers WHERE id=?').get(Number(m[1]));
    if (!sup) return json(res, 404, { error: 'tedarikçi yok' });
    let services;
    try { services = await CatalogStore.getCatalog(sup); }
    catch (e) { services = CatalogStore.readSnapshot(sup.id); }
    const q = (url.searchParams.get('q') || '').toLowerCase();
    let rows = services.map((s) => ({ remote_service_id: s.remote_service_id, name: s.name, price_usd: s.price_usd, stock: s.stock, warranty: s.warranty || classifyWarranty(`${s.name} ${s.description || ''}`) }));
    if (q) rows = rows.filter((r) => String(r.name).toLowerCase().includes(q) || String(r.remote_service_id).toLowerCase().includes(q));
    const limit = Math.min(50, num(url.searchParams.get('limit'), 25));
    const offset = Math.max(0, num(url.searchParams.get('offset'), 0));
    return json(res, 200, { data: rows.slice(offset, offset + limit), meta: { total: rows.length, limit, offset } });
  }

  // ---- matches queue ----
  if (M === 'GET' && route === 'matches') {
    const rows = db.prepare(`SELECT m.*, s.name sname, p.name pname FROM product_matches m
      JOIN suppliers s ON s.id=m.supplier_id LEFT JOIN products p ON p.id=m.product_id WHERE m.status='pending' ORDER BY m.score DESC LIMIT 100`).all();
    return json(res, 200, { data: rows.map((r) => ({ id: r.id, supplier: r.sname, remote_service_id: r.remote_service_id, score: r.score, product_id: r.product_id, product: r.pname ? CS.localized({ name: r.pname }, 'tr') : null })) });
  }
  m = route.match(/^matches\/(\d+)\/(approve|reject)$/);
  if (M === 'POST' && m) {
    try {
      if (m[2] === 'approve') CatalogMatcher.approve(Number(m[1]), ADMIN_ID);
      else CatalogMatcher.reject(Number(m[1]), ADMIN_ID);
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // ---- reservations ----
  if (M === 'GET' && route === 'reservations') {
    const rows = db.prepare(`SELECT r.id, r.user_id, r.qty, r.fulfilled_qty, r.sell_usd, r.status, r.created_at, p.name pn
      FROM reservations r LEFT JOIN products p ON p.id=r.product_id WHERE r.status='PENDING' ORDER BY r.id DESC LIMIT 100`).all();
    return json(res, 200, { data: rows.map((r) => ({ id: r.id, user: r.user_id, product: CS.localized({ name: r.pn }, 'tr'), qty: r.qty, fulfilled: r.fulfilled_qty, paid: round2(r.sell_usd), date: r.created_at })) });
  }

  // ---- pending binance top-ups (auto-verified by DepositPoller) ----
  if (M === 'GET' && route === 'topups') {
    const rows = db.prepare(`SELECT pt.*, u.username FROM pending_topups pt
      LEFT JOIN users u ON u.id = pt.user_id
      ORDER BY CASE pt.status WHEN 'PENDING' THEN 0 ELSE 1 END, pt.id DESC LIMIT 100`).all();
    return json(res, 200, { data: rows });
  }

  // ---- multi-network deposit wallets + provider events ----
  if (M === 'GET' && route === 'deposits') {
    const DepSvc = require('../src/services/DepositProviders');
    const wallets = db.prepare(`SELECT dw.*, u.username FROM deposit_wallets dw LEFT JOIN users u ON u.id=dw.user_id ORDER BY dw.id DESC LIMIT 100`).all();
    const events = db.prepare('SELECT * FROM deposit_events ORDER BY id DESC LIMIT 100').all();
    return json(res, 200, {
      provider: DepSvc.providerConfigured() ? DepSvc.provider : null,
      networks: DepSvc.enabledNetworks().map((n) => ({ key: n.key, label: n.label, icon: n.icon })),
      wallets: wallets.map((w) => ({ id: w.id, user: w.user_id, username: w.username, provider: w.provider, network: w.network, address: w.address, memo: w.address_extra, status: w.status, url: w.label, created: w.created_at })),
      events: events.map((e) => ({ id: e.id, ts: e.ts, provider: e.provider, user: e.user_id, ref: e.ref, usd: e.amount_usd, status: e.status, credited: !!e.credited }))
    });
  }

  // ---- api keys ----
  if (M === 'GET' && route === 'keys') {
    const rows = db.prepare('SELECT id, name, key_preview, scopes, rate_limit_per_min, daily_limit, user_id, webhook_url, enabled, created_at, last_used_at FROM api_keys ORDER BY id DESC').all();
    return json(res, 200, { data: rows.map((k) => ({ ...k, scopes: (() => { try { return JSON.parse(k.scopes); } catch (e) { return []; } })(), webhook_configured: !!k.webhook_url })) });
  }
  if (M === 'POST' && route === 'keys') {
    if (!body.name) return json(res, 400, { error: 'name gerekli' });
    const k = generateApiKey(String(body.name), body, ADMIN_ID);
    return json(res, 201, { data: k, note: 'KEY ONLY SHOWN ONCE — store it now' });
  }
  m = route.match(/^keys\/(\d+)$/);
  if (m && (M === 'PATCH' || M === 'DELETE')) {
    const id = Number(m[1]);
    if (M === 'DELETE') { db.prepare('DELETE FROM api_keys WHERE id=?').run(id); return json(res, 200, { ok: true }); }
    const fields = []; const set = [];
    if (body.enabled !== undefined) { fields.push('enabled'); set.push(body.enabled ? 1 : 0); }
    if (body.rate_limit_per_min !== undefined) { fields.push('rate_limit_per_min'); set.push(Math.max(1, num(body.rate_limit_per_min, 120))); }
    if (body.daily_limit !== undefined) { fields.push('daily_limit'); set.push(num(body.daily_limit, null)); }
    if (body.user_id !== undefined) { fields.push('user_id'); set.push(num(body.user_id, null)); }
    if (body.webhook_url !== undefined) { fields.push('webhook_url'); set.push(body.webhook_url || null); }
    if (!fields.length) return json(res, 400, { error: 'alan yok' });
    db.prepare(`UPDATE api_keys SET ${fields.map((f) => `${f}=?`).join(',')} WHERE id=?`).run(...set, id);
    return json(res, 200, { ok: true });
  }

  // ---- api observability ----
  if (M === 'GET' && route === 'apilog') {
    const limit = Math.min(200, num(url.searchParams.get('limit'), 50));
    const onlyErrors = url.searchParams.get('errors') === '1';
    const rows = db.prepare(`SELECT * FROM api_log ${onlyErrors ? 'WHERE status >= 400' : ''} ORDER BY id DESC LIMIT ?`).all(limit);
    const hooks = db.prepare('SELECT * FROM api_webhook_log ORDER BY id DESC LIMIT 20').all();
    return json(res, 200, { data: rows, webhooks: hooks });
  }

  return json(res, 404, { error: 'admin route yok' });
}

module.exports = { handleAdmin, generateApiKey, round2 };
