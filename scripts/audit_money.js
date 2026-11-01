#!/usr/bin/env node
/**
 * audit_money.js — READ-ONLY scanner for historic 100x money corruption.
 *
 * The old input parser saved "74,45" as 7445 (comma stripped). This script
 * lists orders/transactions whose numbers look inflated so the admin can fix
 * them from the order screen (✏️ Geliri Düzenle) with the new safe parser.
 * Nothing is modified here.
 */
const { db } = require('../src/db');

function fmt(n) { return Number(n || 0).toFixed(2); }

const suspects = [];

// 1) orders: sell_usd absurdly high relative to qty & product price
const orders = db.prepare(`
  SELECT o.*, p.price AS prod_price, p.name AS prod_name
  FROM orders o LEFT JOIN products p ON p.id = o.product_id
  ORDER BY o.id DESC
`).all();

for (const o of orders) {
  const qty = Math.max(1, o.qty || 1);
  const unit = (o.sell_usd || 0) / qty;
  const ref = o.prod_price || 0;
  if (ref > 0 && unit > ref * 20) {
    suspects.push({
      kind: 'order', id: o.id, why: `birim ${fmt(unit)}$ >> referans ${fmt(ref)}$ (≥20x)`,
      sell_usd: o.sell_usd, cost_usd: o.cost_usd, qty, product: o.prod_name, created_at: o.created_at
    });
  }
  // integer-looking cents: "7445.00" style with no fraction AND huge for this shop
  if ((o.sell_usd || 0) > 1000 && ref > 0 && o.sell_usd > ref * qty * 20) {
    // already covered above, skip dupes
  }
  if ((o.cost_usd || 0) > 500 && ref > 0 && o.cost_usd > ref * 50) {
    suspects.push({ kind: 'order(cost)', id: o.id, why: `maliyet ${fmt(o.cost_usd)}$ referansın 50x üstü`, sell_usd: o.sell_usd, cost_usd: o.cost_usd, qty, product: o.prod_name, created_at: o.created_at });
  }
}

// 2) transactions: amounts wildly above any product price
const txs = db.prepare(`
  SELECT t.*, p.price AS prod_price FROM transactions t
  LEFT JOIN products p ON p.id = t.product_id
  WHERE t.status IN ('SUCCESS','completed') ORDER BY t.id DESC
`).all();
for (const t of txs) {
  const ref = t.prod_price || 0;
  if (ref > 0 && t.amount > ref * 2000) {
    suspects.push({ kind: 'transaction', id: t.id, why: `tutar ${fmt(t.amount)}$ ürün fiyatının 2000x üstü (toplu alım olabilir, elle bak)`, amount: t.amount, product: ref, created_at: t.created_at });
  }
}

// 3) users balances with suspicious magnitude
const users = db.prepare('SELECT id, balance FROM users WHERE balance > 5000 ORDER BY balance DESC LIMIT 20').all();
for (const u of users) suspects.push({ kind: 'user', id: u.id, why: `bakiye ${fmt(u.balance)}$ (5000$ üstü — elle onayla)`, amount: u.balance });

console.log(`🔍 ${suspects.length} şüpheli kayıt bulundu (salt-okunur rapor):\n`);
for (const s of suspects) {
  console.log(`[${s.kind} #${s.id}] ${s.why}`);
  if (s.created_at) console.log(`   tarih: ${s.created_at}`);
}
if (suspects.length) {
  console.log('\nDüzeltme: /admin → 📝 Son Siparişler → sipariş → ✏️ Geliri/Maliyeti/Kazancı Düzenle (yeni güvenli parser).');
}
