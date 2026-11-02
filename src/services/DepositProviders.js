/**
 * Multi-network crypto deposits — "kişiye özel cüzdan".
 *
 * Supported networks (catalog below): USDT·BEP20, USDT·Polygon, USDT·TRC20,
 * TON (native), USDT·TON, LTC. Actual on-chain address issuance + payment
 * detection come from a CUSTODY-AGGREGATOR PROVIDER (running your own nodes
 * is out of scope on a VDS bot):
 *
 *   coinpayments — persistent per-user deposit address per coin
 *                  (v2 RPC create_deposit_address; label = user id;
 *                   true personal wallet + payment_id/memo for TON)
 *   nowpayments  — hosted invoice per payment with a unique address
 *                  (x-api-key; check endpoint gives settled fiat)
 *
 * Everything is gated by .env; with no credentials the feature is invisible
 * in both bot and web (zero behavior change). Two delivery rails:
 *   1. IPN webhooks on the web server (/ipn/coinpayments, /ipn/nowpayments)
 *      — signature-verified, idempotent via deposit_events UNIQUE(provider,ref)
 *   2. DepositPoller sweep via provider check APIs — same credit path.
 *
 * Crediting is centralized here (one amount normalization, one transaction
 * row, one notification pair) — no double paths, no split-brain with the
 * Binance top-up flow (that one keeps its own table & guards).
 */
const crypto = require('crypto');
const { db } = require('../db');
const { getUsdTryRate } = require('../utils/currency');

const PROVIDER = String(process.env.DEPOSIT_PROVIDER || '').toLowerCase(); // ''|coinpayments|nowpayments
const CP_MERCHANT = process.env.COINPAYMENTS_MERCHANT_ID || '';
const CP_KEY = process.env.COINPAYMENTS_API_KEY || '';
const CP_SECRET = process.env.COINPAYMENTS_API_SECRET || '';
const CP_IPN_SECRET = process.env.COINPAYMENTS_IPN_SECRET || '';
const NP_KEY = process.env.NOWPAYMENTS_API_KEY || '';
const NP_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || '';
const PUBLIC_URL = process.env.WEB_PUBLIC_URL || '';

// ---------------------------------------------------------------- networks
const NETWORKS = [
  { key: 'usdt_bep20', label: 'USDT · BEP20 (BSC)', icon: '🟡', cp: 'usdtbep20', np: 'usdt_bep20' },
  { key: 'usdt_polygon', label: 'USDT · Polygon', icon: '🟣', cp: 'usdtpolygon', np: 'usdt_poly' },
  { key: 'usdt_trc20', label: 'USDT · TRC20', icon: '🔴', cp: 'usdttrc20', np: 'usdt_trc20' },
  { key: 'ton', label: 'TON (native coin)', icon: '💎', cp: 'ton', np: 'ton' },
  { key: 'usdt_ton', label: 'USDT · TON', icon: '💠', cp: 'usdtton', np: 'usdt_ton' },
  { key: 'ltc', label: 'Litecoin (LTC)', icon: '⛓️', cp: 'ltc', np: 'ltc' }
];

function enabledNetworks() {
  const want = String(process.env.DEPOSIT_NETWORKS || NETWORKS.map((n) => n.key).join(','))
    .split(',').map((s) => s.trim()).filter(Boolean);
  return NETWORKS.filter((n) => want.includes(n.key));
}

function networkByKey(key) {
  return NETWORKS.find((n) => n.key === key) || null;
}

function providerConfigured() {
  if (PROVIDER === 'coinpayments') return !!(CP_MERCHANT && CP_KEY && CP_SECRET);
  if (PROVIDER === 'nowpayments') return !!NP_KEY;
  return false;
}

// ---------------------------------------------------------------- http seam
// injectable for offline tests (scripts/test_deposits.js mocks this)
let httpClient = null;
function setHttpClient(fn) { httpClient = fn; }
async function httpCall(opts) {
  if (httpClient) return httpClient(opts);
  const axios = require('axios');
  const res = await axios({ ...opts, timeout: opts.timeout || 15000 });
  return res.data;
}

// ---------------------------------------------------------------- coinpayments
function cpRpc(cmd, params = {}) {
  const body = new URLSearchParams({
    merchant_id: CP_MERCHANT, version: '2', cmd, format: 'json', ...toStr(params)
  }).toString();
  const hmac = crypto.createHmac('sha1', CP_SECRET).update(body).digest('hex');
  const uriHash = crypto.createHash('md5').update('/api2.php').digest('hex');
  return httpCall({
    method: 'POST',
    url: 'https://www.coinpayments.net/api2.php',
    data: body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'cp-hmac': hmac,
      'cp-uri-hash': uriHash
    }
  }).then((d) => {
    if (!d || d.status !== 200) throw new Error(`coinpayments ${cmd}: ${JSON.stringify(d).slice(0, 200)}`);
    return d.data;
  });
}
function toStr(o) { const out = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = String(v); return out; }

async function cpCreateWallet(userId, net) {
  const data = await cpRpc('create_deposit_address', { currency1: net.cp, label: `u${userId}` });
  return {
    provider: 'coinpayments', network: net.key,
    address: data.address || null,
    address_extra: data.payment_id || data.address2 || null, // TON memo lives here
    provider_ref: String(data.id || ''),
    url: data.payment_url || null
  };
}

async function cpCheckWallet(wallet) {
  // list_deposit_addresses returns cumulative `received` per address; we
  // credit DELTAS vs last_seen — the wallet row tracks the last booked sum.
  const rows = await cpRpc('list_deposit_addresses', { currency1: networkByKey(wallet.network).cp, label: `u${wallet.user_id}` });
  const arr = Array.isArray(rows) ? rows : (rows && rows.addresses) || [];
  const me = arr.find((a) => String(a.id) === String(wallet.provider_ref));
  if (!me) return null;
  return { status: Number(me.received || 0) > Number(wallet.last_seen || 0) ? 'new_funds' : 'waiting', raw: me };
}

// ---------------------------------------------------------------- nowpayments
// NOWPayments Personal Crypto Address (PCA) — kalıcı kişiye özel cüzdan.
// Her (customer_id, currency) çifti için TEK adres, süresiz, tekrar kullanılabilir.
// Invoice modelinden farklı: kullanıcı aynı adrese defalarca gönderebilir.
function npApi(method, path, body) {
  return httpCall({
    method, url: `https://api.nowpayments.io${path}`, data: body,
    headers: { 'x-api-key': NP_KEY, 'Content-Type': 'application/json' }
  });
}

/**
 * PCA create — idempotent: aynı customer_id+currency zaten varsa mevcut adresi döner.
 * customer_id = `u<telegram_user_id>` formatında saklanır.
 */
async function npCreateWallet(userId, net) {
  const customerId = `u${userId}`;
  try {
    const data = await npApi('POST', '/v1/personal-crypto-address', {
      customer_id: customerId, currency: net.np,
      ipn_callback_url: PUBLIC_URL ? `${PUBLIC_URL.replace(/\/$/, '')}/ipn/nowpayments` : undefined
    });
    const pca = data.result || data;
    return { provider: 'nowpayments', network: net.key, address: pca.address || null,
      address_extra: null, provider_ref: `pca:${String(pca.id || '')}`, url: null, customer_id: customerId };
  } catch (e) {
    // PCA is not enabled for every NOWPayments account. Such accounts return
    // 404 despite having a valid API key; fall back to a normal pay-in.
    if (e.response?.status !== 404 && e.status !== 404) throw e;
    const data = await npApi('POST', '/v1/payment', {
      price_amount: 1, price_currency: 'usd', pay_currency: net.np,
      order_id: `wallet_${userId}_${net.key}_${Date.now()}`,
      ipn_callback_url: PUBLIC_URL ? `${PUBLIC_URL.replace(/\/$/, '')}/ipn/nowpayments` : undefined
    });
    const payment = data.payment || data;
    if (!payment.pay_address) throw new Error('NOWPayments bu ağ için yatırım adresi üretmedi');
    return { provider: 'nowpayments', network: net.key, address: payment.pay_address,
      address_extra: payment.payin_extra_id || null,
      provider_ref: `payment:${String(payment.payment_id || payment.id || '')}`,
      url: payment.invoice_url || null, customer_id: customerId };
  }
}

/**
 * PCA payment check — lists recent payments for this address.
 * Returns the newest 'finished' payment not yet credited (if any).
 */
async function npCheckWallet(wallet) {
  if (String(wallet.provider_ref || '').startsWith('payment:')) {
    const id = String(wallet.provider_ref).slice('payment:'.length);
    const data = await npApi('GET', `/v1/payment/${encodeURIComponent(id)}`);
    const payment = data.payment || data;
    const status = String(payment.payment_status || payment.status || '').toLowerCase();
    if (!['finished', 'confirmed', 'paid'].includes(status)) return { status: 'waiting', usd: 0, raw: payment };
    return { status: 'settled', usd: Number(payment.price_amount || payment.actually_paid || payment.pay_amount || 0),
      payment_id: payment.payment_id || payment.id, raw: payment };
  }
  const ref = String(wallet.provider_ref || '').replace(/^pca:/, '');
  const data = await npApi('GET', `/v1/personal-crypto-address/${ref}/payments?limit=20`);
  const payments = (data.data || data || []);
  // Find the newest finished payment
  const finished = payments.find((p) =>
    ['finished', 'confirmed', 'paid'].includes(String(p.payment_status || '').toLowerCase())
  );
  if (!finished) return { status: 'waiting', usd: 0, raw: null };
  const usd = Number(finished.price_amount || finished.actually_paid || finished.pay_amount || 0);
  return { status: 'settled', usd, payment_id: finished.payment_id, raw: finished };
}

// ---------------------------------------------------------------- wallets
/**
 * Get or create the user's personal deposit wallet for a network.
 * CoinPayments: persistent/reusable (true personal wallet).
 * NOWPayments: invoices are per-payment — a settled invoice spawns a new one.
 */
async function getDepositWallet(userId, networkKey) {
  const net = networkByKey(networkKey);
  if (!net) throw new Error('bilinmeyen ağ');
  if (!providerConfigured()) throw new Error('ödeme sağlayıcısı yapılandırılmadı');

  const row = db.prepare('SELECT * FROM deposit_wallets WHERE user_id=? AND provider=? AND network=?')
    .get(userId, PROVIDER, net.key);

  if (PROVIDER === 'coinpayments') {
    if (row && row.status === 'ACTIVE' && row.address) return row;
    const w = await cpCreateWallet(userId, net);
    return upsertWallet(userId, w, row);
  }

  // nowpayments PCA — kalıcı adres, invoice gibi expire olmaz
  if (row && row.status === 'ACTIVE' && row.address) return row;
  const w = await npCreateWallet(userId, net);
  return upsertWallet(userId, w, row);
}

function upsertWallet(userId, w, old) {
  db.prepare(`INSERT INTO deposit_wallets (user_id, provider, network, address, address_extra, status, provider_ref, label)
              VALUES (?,?,?,?,?,'ACTIVE',?,?)
              ON CONFLICT(user_id, provider, network) DO UPDATE SET
                address=excluded.address, address_extra=excluded.address_extra,
                provider_ref=excluded.provider_ref, label=excluded.label,
                status='ACTIVE', updated_at=CURRENT_TIMESTAMP`)
    .run(userId, w.provider, w.network, w.address, w.address_extra, w.provider_ref, w.url || w.order || null);
  return db.prepare('SELECT * FROM deposit_wallets WHERE user_id=? AND provider=? AND network=?').get(userId, w.provider, w.network);
}

function listUserWallets(userId) {
  return db.prepare("SELECT * FROM deposit_wallets WHERE user_id=? AND status='ACTIVE' ORDER BY network").all(userId);
}

// ---------------------------------------------------------------- credit path
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Pick the USD value out of heterogeneous provider payloads. */
function extractUsd(ev) {
  const cands = [
    ev.price_amount, ev.outcome_amount, ev.actual_usd_paid, ev.actually_paid,
    ev.price_paid_usd, ev.amount_usd, ev.fiat_amount, ev.price, ev.amount
  ];
  for (const c of cands) {
    const v = Number(c);
    if (v > 0 && v < 1e6) return v;
  }
  return 0;
}

/**
 * Central idempotent credit. ref = provider payment id (or txid).
 * deposit_events UNIQUE(provider,ref) is the single guard; transactions get
 * a synthetic txid '<provider>:<ref>' so all wallet history stays coherent.
 */
async function creditDeposit({ provider, ref, userId, usd, network, payload, bot }) {
  if (!ref || !(usd > 0)) return { ok: false, reason: 'invalid' };
  const dup = db.prepare('SELECT 1 FROM deposit_events WHERE provider=? AND ref=?').get(provider, ref);
  if (dup) return { ok: false, reason: 'dup' };

  const user = db.prepare('SELECT balance FROM users WHERE id=?').get(userId);
  if (!user) {
    db.prepare('INSERT INTO deposit_events (provider,network,user_id,ref,amount_usd,status,credited,payload) VALUES (?,?,?,?,?,?,0,?)')
      .run(provider, network || null, userId, ref, usd, 'no_user', JSON.stringify(payload || {}).slice(0, 1500));
    return { ok: false, reason: 'no_user' };
  }

  const tryRate = await getUsdTryRate().catch(() => 47.22);
  const nextBal = round2((user.balance || 0) + usd);
  db.transaction(() => {
    db.prepare('INSERT INTO deposit_events (provider,network,user_id,ref,amount_usd,status,credited,payload) VALUES (?,?,?,?,?,?,1,?)')
      .run(provider, network || null, userId, ref, usd, 'confirmed', JSON.stringify(payload || {}).slice(0, 1500));
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(nextBal, userId);
    db.prepare('INSERT INTO transactions (txid, user_id, product_id, amount, status, amount_try) VALUES (?,?,?,?,?,?)')
      .run(`${provider}:${ref}`, userId, null, usd, 'SUCCESS', usd * tryRate);
  })();

  const notify = async (chat, msg) => {
    try { if (bot && bot.telegram && chat) await bot.telegram.sendMessage(chat, msg); } catch (e) {}
  };
  await notify(userId, `✅ ${networkLabel(network)} ödemen doğrulandı: bakiyene +${usd}$ yüklendi.\nYeni bakiye: ${nextBal}$`);
  const { ADMIN_ID } = require('../config/env');
  await notify(ADMIN_ID, `💳 Kripto yatırma: user ${userId} · ${networkLabel(network)} +${usd}$ (ref ${ref}) · bakiye ${nextBal}$`);
  return { ok: true, balance: nextBal, usd };
}

function networkLabel(key) {
  const n = networkByKey(key);
  return n ? `${n.icon} ${n.label}` : (key || '?');
}

// ---------------------------------------------------------------- IPN verify
function verifyNpSignature(rawBody, sigHeader) {
  if (!NP_IPN_SECRET || !sigHeader) return false;
  const expected = crypto.createHmac('sha256', NP_IPN_SECRET).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(sigHeader), 'hex')); } catch (e) { return false; }
}

function verifyCpSignature(rawBody, sigHeader) {
  if (!CP_IPN_SECRET || !sigHeader) return false;
  const expected = crypto.createHmac('sha1', CP_IPN_SECRET).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sigHeader))); } catch (e) { return false; }
}

/**
 * NOWPayments PCA IPN body: { payment_id, payment_status, pay_address,
 * price_amount, actually_paid, pay_currency, customer_id, address_id }.
 * PCA IPNs have order_id=null — user identified via customer_id or address.
 */
async function handleNpIpn(body, bot) {
  const status = String(body.payment_status || body.status || '').toLowerCase();
  if (!['finished', 'confirmed', 'paid', 'partial'].includes(status)) return { ignored: status };

  // 1) PCA customer_id → u<userId>
  let userId = null;
  const cid = String(body.customer_id || '');
  const cidMatch = cid.match(/^u(\d+)$/);
  if (cidMatch) userId = Number(cidMatch[1]);

  // 2) Fallback: pay_address → wallet lookup
  let network = null;
  if (!userId && body.pay_address) {
    const w = db.prepare("SELECT user_id, network FROM deposit_wallets WHERE address=? AND provider='nowpayments'").get(body.pay_address);
    if (w) { userId = w.user_id; network = w.network; }
  }
  // 3) Fallback: legacy invoice order_id (backward compat)
  if (!userId) {
    const om = String(body.order_id || '');
    const parsed = om.match(/^DP(\d+)-(.+)-[0-9a-f]{6}$/);
    if (parsed) { userId = Number(parsed[1]); network = parsed[2]; }
  }

  if (!userId) return { ignored: 'no_user' };
  if (!network && body.pay_currency) {
    const net = NETWORKS.find((n) => n.np === body.pay_currency);
    if (net) network = net.key;
  }
  const ref = String(body.payment_id || `pca${Date.now()}`);
  return creditDeposit({
    provider: 'nowpayments', ref, userId, usd: round2(extractUsd(body)),
    network, payload: body, bot
  });
}

/**
 * CoinPayments IPN (form fields): txn_id, status:1, amount1/amount2,
 * currency1, address, account_email… We map by deposit address (personal
 * wallet rows), amount via amount1 (already USD for usdt* coins on CP).
 */
async function handleCpIpn(fields, bot) {
  if (String(fields.status) !== '1') return { ignored: 'not confirmed' };
  const addr = String(fields.address || '');
  const w = addr && db.prepare("SELECT * FROM deposit_wallets WHERE address=? AND provider='coinpayments'").get(addr);
  if (!w) return { ignored: 'unknown address' };
  const usd = round2(Number(fields.amount1 || fields.amount || 0)) || round2(extractUsd(fields));
  const ref = String(fields.txn_id || fields.txnids || `cp${Date.now()}`);
  return creditDeposit({ provider: 'coinpayments', ref, userId: w.user_id, usd, network: w.network, payload: fields, bot });
}

module.exports = {
  providerConfigured, enabledNetworks, networkByKey, networkLabel,
  getDepositWallet, listUserWallets, creditDeposit,
  handleNpIpn, handleCpIpn, verifyNpSignature, verifyCpSignature,
  npCheckWallet, cpCheckWallet, extractUsd,
  setHttpClient,
  get provider() { return PROVIDER; },
  get PUBLIC_URL() { return PUBLIC_URL; }
};
