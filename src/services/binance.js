/**
 * Binance Pay verification — the SINGLE source of truth for
 * "did this customer actually pay us?".
 *
 * Why this was rewritten (the old bug):
 *   The first implementation queried /sapi/v1/capital/deposit/hisrec with a
 *   txId= filter (unsupported by that endpoint) while customers paste their
 *   Binance PAY order number (e.g. 457703115609456640). Pay transfers to the
 *   store's Pay ID land in the Pay WALLET history, not in on-chain deposits —
 *   automatic top-up could therefore never match. Verified live:
 *
 *   GET /sapi/v1/pay/transactions?beginTime&endTime&limit(≤100)
 *     → { code:"000000", data:[ { orderId:"457703115609456640",
 *           amount:"10", currency:"USDT", orderType:"C2C",
 *           transactionId:"P_A24S…", transactionTime:… ,
 *           payerInfo:{name,type,binanceId}, receiverInfo:{binanceId},
 *           totalPaymentFee } ] }
 *
 *   Notes learned from the live API:
 *     - there is NO server-side filter: payTradeNo/page params are IGNORED;
 *       matching is client-side on `orderId` (or `transactionId`).
 *     - hard cap 100 rows per call → recursive window splitting for full
 *       coverage of a time range.
 *     - amount > 0 = money IN (a customer deposit), < 0 = our own outgoing.
 *     - settled history rows ARE the confirmation — status SUCCESS.
 *
 * checkTransaction() keeps the historical {amount, status} contract (amount
 * normalized to USD) plus additive fields; the legacy on-chain hisrec path is
 * retained as a fallback for direct wallet deposits.
 */
const axios = require('axios');
const crypto = require('crypto');
const { BINANCE_API_KEY, BINANCE_SECRET_KEY } = require('../config/env');
const { getUsdTryRate } = require('../utils/currency');

const BASE = 'https://api.binance.com';
const PAY_PATH = '/sapi/v1/pay/transactions';
const DAY = 24 * 3600 * 1000;
const USDT_LIKE = new Set(['USDT', 'USD', 'FDUSD', 'BUSD', 'USDC', 'USDE']);

// memo: pasted-id -> settled row (10 min) so a hammering user costs no weight
const FOUND_TTL = 10 * 60 * 1000;
const foundMemo = new Map();

function credsOk() {
  return !!(BINANCE_API_KEY && BINANCE_SECRET_KEY);
}

function calculateSignature(queryString) {
  return crypto.createHmac('sha256', BINANCE_SECRET_KEY).update(queryString).digest('hex');
}

async function signedGet(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries({ ...params, timestamp: Date.now(), recvWindow: 10000 })
      .map(([k, v]) => [k, String(v)])
  ).toString();
  const res = await axios({
    method: 'GET',
    url: `${BASE}${path}?${qs}&signature=${calculateSignature(qs)}`,
    headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
    timeout: 15000
  });
  return res.data;
}

// ---------------------------------------------------------------- raw rows
function normRow(it) {
  const amt = parseFloat(it.amount) || 0;
  return {
    orderId: String(it.orderId || ''),
    transactionId: String(it.transactionId || ''),
    orderType: it.orderType || null,
    transactionTime: it.transactionTime || null,
    amount: Math.abs(amt),
    direction: amt >= 0 ? 'IN' : 'OUT',
    currency: it.currency || 'USDT',
    counterparty: (it.payerInfo && it.payerInfo.name) || (it.receiverInfo && it.receiverInfo.name) || null,
    raw: it
  };
}

/** One API page: rows in [begin,end], newest first, max 100. */
async function payWindow(beginTime, endTime, limit = 100) {
  const d = await signedGet(PAY_PATH, { beginTime, endTime, limit });
  if (!d) return [];
  if (d.code && d.code !== '000000') throw new Error(`pay/transactions: ${d.code} ${d.msg || d.message || ''}`);
  return (Array.isArray(d.data) ? d.data : []).map(normRow);
}

/**
 * Recursively fetch every row in [begin,end] despite the 100-row cap:
 * a saturated window is split in half (newest half first), depth-limited.
 * @param {object} opts { match:(row)=>boolean, stop:'first'|'all', maxDepth }
 */
async function scanWindow(begin, end, opts = {}) {
  const { match = () => true, stop = 'all', maxDepth = 7 } = opts;
  const rows = await payWindow(begin, end);
  const hits = rows.filter(match);
  if (hits.length && stop === 'first') return hits[0];
  if (rows.length >= 100 && end - begin > 2 * 60 * 1000 && maxDepth > 0) {
    // Saturated window: the halves together cover what the truncated page
    // (newest 100) could have missed. Do NOT merge `hits` — they are part of
    // the newer half and would double-count.
    const child = { ...opts, maxDepth: maxDepth - 1 };
    const mid = Math.floor((begin + end) / 2);
    if (stop === 'first') {
      return (await scanWindow(mid, end, child)) || (await scanWindow(begin, mid, child)) || null;
    }
    return [...(await scanWindow(mid, end, child)), ...(await scanWindow(begin, mid, child))];
  }
  return stop === 'first' ? null : hits;
}

/**
 * Find a Pay transfer by the order number the CUSTOMER pasted
 * (matches orderId or transactionId). Searches back `days`.
 */
async function findPayOrder(idStr, { days = 45 } = {}) {
  const id = String(idStr || '').trim();
  if (!id) return null;
  const memo = foundMemo.get(id);
  if (memo && Date.now() - memo.at < FOUND_TTL) return memo.row;

  const end = Date.now();
  const begin = end - days * DAY;
  const match = (r) => r.orderId === id || r.transactionId === id;
  let row = null;
  try {
    row = await scanWindow(begin, end, { match, stop: 'first' });
  } catch (e) {
    console.error('[binance] pay scan failed:', e.message);
    return null;
  }
  if (!row) return null;
  const usd = await toUsd(row);
  const out = {
    source: 'binance_pay_wallet',
    payTradeNo: row.orderId,
    transactionId: row.transactionId,
    orderStatus: row.direction === 'IN' ? 'PAID' : 'OUTGOING',
    amount: usd.amount,
    currency: row.currency,
    currency_amount: row.amount,
    status: row.direction === 'IN' ? 'SUCCESS' : 'FAILED', // out-goings are never a deposit
    createTime: row.transactionTime,
    counterparty: row.counterparty,
    raw: row.raw
  };
  foundMemo.set(id, { at: Date.now(), row: out });
  if (foundMemo.size > 500) {
    const cut = Date.now() - FOUND_TTL;
    for (const [k, v] of foundMemo) if (v.at < cut) foundMemo.delete(k);
  }
  return out;
}

/** Normalize a Pay row amount to USD (prices are USD; TRY deposits divide). */
async function toUsd(row) {
  const cur = String(row.currency || 'USDT').toUpperCase();
  if (USDT_LIKE.has(cur)) return { amount: round2(row.amount), usd_like: true };
  if (cur === 'TRY') {
    const rate = await getUsdTryRate();
    return { amount: round2(row.amount / (rate || 47.22)), usd_like: false };
  }
  // unknown asset — treat face value as USD but flag it (admin can review)
  return { amount: round2(row.amount), usd_like: false };
}

/** Settled INCOMING Pay deposits over the last `days` (admin/debug). */
async function recentDeposits(days = 7) {
  const end = Date.now();
  const begin = end - days * DAY;
  const rows = await scanWindow(begin, end, { match: (r) => r.direction === 'IN' });
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const u = await toUsd(r);
    out.push({ ...r, amount_usd: u.amount });
  }
  return out;
}

// ---------------------------------------------------------------- on-chain
/**
 * Legacy fallback: on-chain deposit into the merchant's Binance account.
 * hisrec has NO txId filter — fetch a window, match client-side.
 */
async function findDepositTx(txid) {
  const endTime = Date.now();
  const beginTime = endTime - 90 * DAY;
  const d = await signedGet('/sapi/v1/capital/deposit/hisrec', { beginTime, endTime });
  const list = Array.isArray(d) ? d : [];
  const dep = list.find((x) => String(x.txId) === String(txid) || String(x.transferId) === String(txid));
  if (!dep) return null;
  return {
    source: 'binance_deposit',
    payTradeNo: String(txid),
    orderStatus: dep.status === 1 ? 'SUCCESS' : `CONFIRMING_${dep.confirmations || 0}`,
    amount: parseFloat(dep.amount) || 0,
    currency: dep.coin,
    status: dep.status === 1 ? 'SUCCESS' : 'PENDING',
    createTime: dep.insertTime || null,
    raw: dep
  };
}

// ---------------------------------------------------------------- facade
/**
 * checkTransaction(id) — Pay history first (what customers actually use),
 * on-chain hisrec second. Returns the historical {amount, status} contract.
 */
async function checkTransaction(idStr) {
  const id = String(idStr || '').trim();
  if (!id || !credsOk()) return null;
  const pay = await findPayOrder(id);
  if (pay) return pay;
  try {
    const dep = await findDepositTx(id);
    if (dep) return dep;
  } catch (e) {
    console.error('[binance] deposit lookup failed:', e.message);
  }
  return null;
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

module.exports = {
  checkTransaction,
  findPayOrder,
  findDepositTx,
  recentDeposits,
  payWindow,
  scanWindow,
  calculateSignature,
  credsOk
};
