#!/usr/bin/env node
/** Warranty gating + class assignment tests for PricingEngine/CatalogStore. */
const assert = require('assert');
const { db } = require('../src/db');
const { classifyWarranty, warrantyAllows, effectiveWarranty } = require('../src/utils/warranty');

(async () => {
  // 1. classifier
  assert.equal(classifyWarranty('Gemini Pro 18M 5H Warranty'), 'guaranteed');
  assert.equal(classifyWarranty('18M pro ( Instant Use )'), 'instant');
  assert.equal(classifyWarranty('Spotify 3 Months Premium'), 'unknown');
  assert.equal(classifyWarranty('Netflix 1 Month No Warranty'), 'instant');
  assert.equal(classifyWarranty('Canva 12M 2 Hour Garantie'), 'guaranteed');

  // 2. matrix
  assert.equal(warrantyAllows('none', 'instant'), true);   // legacy: no filter
  assert.equal(warrantyAllows('none', 'guaranteed'), true);
  assert.equal(warrantyAllows('guaranteed', 'guaranteed'), true);
  assert.equal(warrantyAllows('guaranteed', 'instant'), false);   // THE RULE
  assert.equal(warrantyAllows('guaranteed', 'unknown'), false);   // no surprise
  assert.equal(warrantyAllows('instant', 'instant'), true);
  assert.equal(warrantyAllows('instant', 'guaranteed'), false);
  assert.equal(warrantyAllows('instant', 'unknown'), true);
  assert.equal(effectiveWarranty('auto', 'guaranteed'), 'guaranteed');
  assert.equal(effectiveWarranty('mixed', 'instant'), 'mixed');

  // 3. pricing engine gate with REAL snapshot rows
  const CatalogStore = require('../src/services/CatalogStore');
  CatalogStore.getBalance = async () => 100;
  CatalogStore.getCatalog = async (supplier) => CatalogStore.readSnapshot(supplier.id); // offline: serve DB snapshot

  // temp links on product 2: two in-stock guaranteed services picked from the
  // REAL snapshot (stock/prices drift live — never hardcode row identities)
  const gRows = db.prepare(`SELECT supplier_id, remote_service_id FROM supplier_catalogs
    WHERE warranty='guaranteed' AND stock > 0 AND price_usd IS NOT NULL AND price_usd <= 50
    ORDER BY price_usd LIMIT 2`).all();
  assert(gRows.length > 0, 'need at least one in-stock guaranteed snapshot row');
  const links = gRows.map((r, i) => [2, r.supplier_id, r.remote_service_id, i + 1]);
  for (const [, supId, rid] of links) {
    const row = db.prepare('SELECT name, warranty FROM supplier_catalogs WHERE supplier_id=? AND remote_service_id=?').get(supId, rid);
    if (!row) throw new Error('snapshot missing ' + rid);
    assert.equal(row.warranty, 'guaranteed', rid + ' should classify guaranteed');
  }
  const unknownRow = db.prepare("SELECT supplier_id, remote_service_id FROM supplier_catalogs WHERE warranty='unknown' AND price_usd IS NOT NULL AND stock > 0 LIMIT 1").get();
  if (unknownRow) links.push([2, unknownRow.supplier_id, unknownRow.remote_service_id, 3]);

  const ins = db.prepare('INSERT INTO product_suppliers (product_id, supplier_id, remote_service_id, priority) VALUES (?,?,?,?)');
  const ids = links.map((l) => ins.run(...l).lastInsertRowid);

  const { PricingEngine } = require('../src/services/PricingEngine');
  try {
    // guaranteed product: only guaranteed links eligible
    db.prepare("UPDATE products SET pricing_mode='max_profit', warranty='guaranteed' WHERE id=2").run();
    let d = await PricingEngine.price(db.prepare('SELECT * FROM products WHERE id=2').get(), { qty: 1 });
    const off = d.all.filter((o) => o.warranty !== 'guaranteed' && o.warranty !== 'mixed');
    for (const o of off) assert.equal(o.affordable, false, 'non-guaranteed offer must NOT serve guaranteed product (' + o.warranty + ')');
    const on = d.all.filter((o) => o.warranty === 'guaranteed');
    assert(on.length > 0, 'guaranteed offers must exist');
    for (const o of on) assert(o.reason !== 'warranty_mismatch', 'guaranteed offers allowed');
    assert(on.every((o) => o.affordable), 'guaranteed offers affordable (balance mocked)');
    console.log('  guaranteed product: ' + on.length + ' eligible / ' + d.all.length + ' total');

    // instant product: guaranteed excluded, unknown allowed
    db.prepare("UPDATE products SET warranty='instant' WHERE id=2").run();
    d = await PricingEngine.price(db.prepare('SELECT * FROM products WHERE id=2').get(), { qty: 1 });
    for (const o of d.all) {
      if (o.warranty === 'guaranteed') assert.equal(o.affordable, false, 'instant product must not take guaranteed stock');
      if (o.warranty === 'unknown') assert(o.reason !== 'warranty_mismatch', 'unknown allowed for instant');
    }
    console.log('  instant product gate: OK');

    // legacy 'none' product: no filtering at all (launch-safe)
    db.prepare("UPDATE products SET warranty='none' WHERE id=2").run();
    d = await PricingEngine.price(db.prepare('SELECT * FROM products WHERE id=2').get(), { qty: 1 });
    for (const o of d.all) assert(o.reason !== 'warranty_mismatch', 'none = no warranty filter');
    console.log('  none product passthrough: OK');

    console.log('PricingEngine warranty gate: OK');
  } finally {
    db.prepare("UPDATE products SET pricing_mode='manual', warranty='none' WHERE id=2").run();
    db.prepare(`DELETE FROM product_suppliers WHERE id IN (${ids.join(',')})`).run();
  }

  console.log('warranty tests: all passed ✓');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
