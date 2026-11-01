/**
 * DepositPoller — "otomatik yükleme" guarantee for Binance Pay deposits.
 *
 * When a customer submits a payment number that is not settled at that
 * moment (Pay propagation, wrong id pasted too early, 429 on our lookup…),
 * the bot/web store records a pending_topups row instead of losing the
 * money trail. This poller re-verifies every PENDING row on a gentle cadence
 * and credits the CONFIRMED amount to the user's balance exactly once:
 *
 *   txid UNIQUE                    → same number can never queue twice
 *   transactions.txid pre-check    → same number can never credit twice
 *   7-day TTL                      → stale/never-paid rows go EXPIRED + alert
 *
 * Binance API safety: one lookup per pending row per cycle (3 min), lookups
 * go through the memoized checkTransaction(); pending queues are normally
 * single-digit, so weight usage is negligible even on VDS.
 */
const { db } = require('../db');
const { checkTransaction } = require('./binance');
const { t } = require('../utils/i18n');
const { getUsdTryRate } = require('../utils/currency');
const { ADMIN_ID } = require('../config/env');

const DAY = 24 * 3600 * 1000;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function getUserLang(userId) {
  const u = db.prepare('SELECT lang FROM users WHERE id = ?').get(userId);
  return (u && u.lang) || 'en';
}

async function notify(bot, chatId, text) {
  try {
    if (bot && bot.telegram && chatId) await bot.telegram.sendMessage(chatId, text);
  } catch (e) { /* user blocked the bot — credit already happened */ }
}

/**
 * Process all PENDING rows. Exported separately so handlers/tests can
 * trigger an immediate pass (e.g. right after queueing).
 * @returns {{credited:number, expired:number, waiting:number}}
 */
async function processPending(bot) {
  const rows = db.prepare("SELECT * FROM pending_topups WHERE status = 'PENDING' ORDER BY id").all();
  const out = { credited: 0, expired: 0, waiting: 0 };
  const tryRate = await getUsdTryRate().catch(() => 47.22);

  for (const p of rows) {
    // TTL — never found in history for 7 days → expired + admin alert
    const age = Date.now() - new Date(`${p.created_at}Z`).getTime();
    if (age > 7 * DAY) {
      db.prepare("UPDATE pending_topups SET status='EXPIRED', note=COALESCE(note,'')||' ttl-7d', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id);
      const lang = getUserLang(p.user_id);
      await notify(bot, p.user_id, t(lang, 'payment_not_found') || 'Payment could not be verified.');
      await notify(bot, ADMIN_ID, t('en', 'topup_expired', { id: p.id, user: p.user_id, txid: p.txid }));
      out.expired++;
      continue;
    }

    let info;
    try {
      info = await checkTransaction(p.txid);
    } catch (e) {
      out.waiting++;
      continue;
    }
    if (!info || info.status !== 'SUCCESS') { out.waiting++; continue; }

    const paid = round2(info.amount || 0);
    if (paid <= 0) { out.waiting++; continue; }

    // double-credit guard (the unique-txid queue already covers most cases)
    const dupe = db.prepare('SELECT 1 FROM transactions WHERE txid = ?').get(p.txid);
    if (dupe) {
      db.prepare("UPDATE pending_topups SET status='CREDITED', confirmed_amount=0, note='already booked', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id);
      out.credited++;
      continue;
    }

    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(p.user_id);
    if (!user) { // account vanished — keep row for the next cycle
      out.waiting++;
      continue;
    }
    const nextBal = round2((user.balance || 0) + paid);

    db.transaction(() => {
      db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(nextBal, p.user_id);
      db.prepare('INSERT INTO transactions (txid, user_id, product_id, amount, status, amount_try) VALUES (?,?,?,?,?,?)')
        .run(p.txid, p.user_id, p.product_id || null, paid, 'SUCCESS', paid * tryRate);
      db.prepare("UPDATE pending_topups SET status='CREDITED', confirmed_amount=?, note=COALESCE(note,'')||' auto-credited', updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(paid, p.id);
    })();

    const lang = getUserLang(p.user_id);
    await notify(bot, p.user_id, t(lang, 'topup_credited', { amount: paid, balance: nextBal }));
    await notify(bot, ADMIN_ID, `💳 Binance yatırma otomatik onaylandı\nUser ${p.user_id} · ${p.txid}\n+${paid}$ (bakiye: ${nextBal}$) · kaynak: ${p.source}`);
    out.credited++;
  }
  return out;
}

let timer = null;

function start(bot, everyMs = 3 * 60 * 1000) {
  if (timer) return;
  const tick = async () => {
    try {
      const pending = db.prepare("SELECT COUNT(*) c FROM pending_topups WHERE status='PENDING'").get().c;
      if (!pending) return;
      const r = await processPending(bot);
      if (r.credited || r.expired) console.log(`[DepositPoller] credited=${r.credited} expired=${r.expired} waiting=${r.waiting}`);
    } catch (e) {
      console.error('[DepositPoller]', e.message);
    }
  };
  timer = setInterval(tick, everyMs);
  if (timer.unref) timer.unref();
  // first pass shortly after boot (payments that arrived during downtime)
  setTimeout(tick, 20000).unref?.();
  console.log('[DepositPoller] started (3-min cycle for pending Binance top-ups)');
}

module.exports = { start, processPending };
