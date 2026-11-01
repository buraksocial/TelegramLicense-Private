#!/usr/bin/env node
/** Offline unit tests for PricingEngine decision logic (no network). */
const assert = require('assert');
const { PricingEngine, maskedStock, parseTiers, tierPrice, round2 } = require('../src/services/PricingEngine');

function mkOffer(over = {}) {
  const qty = over.qty || 1;
  const cost = over.cost * qty;
  let affordable = true, reason = null;
  if (over.balance === null) { affordable = false; reason = 'no_balance'; }
  else if (over.balance !== undefined && over.balance < cost) { affordable = false; reason = 'insufficient_balance'; }
  else if (over.stock !== undefined && over.stock < qty) { affordable = false; reason = 'out_of_stock'; }
  return {
    product_supplier_id: over.id,
    supplier: { id: over.supplier_id, min_stock_buffer: 0 },
    supplier_id: over.supplier_id,
    remote_service_id: over.sid || 'svc',
    unitCost: over.cost,
    cost,
    tiers: over.tiers || [{ min: 1, max: Infinity, price: over.cost }],
    realStock: over.stock !== undefined ? over.stock : 100,
    balance: over.balance !== undefined ? over.balance : 1000,
    margin: over.margin !== undefined ? over.margin : 150,
    floor: over.floor !== undefined ? over.floor : 0,
    sellUnit: round2(Math.max(over.cost * (1 + (over.margin !== undefined ? over.margin : 150) / 100), over.floor || 0)),
    marginPct: 150,
    priority: over.priority || 1,
    affordable,
    reason,
    ...over.extra
  };
}

// --- tier math ---
assert.strictEqual(tierPrice([{ min: 1, max: 5, price: 2 }, { min: 6, max: null, price: 1.5 }], 7), 1.5);
assert.strictEqual(tierPrice([{ min: 1, max: 5, price: 2 }], 3), 2);
assert.deepStrictEqual(parseTiers('[{"min":1,"max":null,"price":2.5}]'), [{ min: 1, max: Infinity, price: 2.5 }]);
assert.strictEqual(parseTiers('garbage'), null);

const product1 = {
  id: 1, price: 5, pricing_mode: 'max_profit', supplier_selection_mode: 'cheapest',
  default_margin_percent: 150, default_floor_price: 3
};

// --- scenario from user: floor $3 => A sellUnit max(1.5,3)=3, B max(3.75,3)=3.75
const A = mkOffer({ id: 'A', supplier_id: 1, sid: 'svcA', cost: 0.6, stock: 10, floor: 3 });
const B = mkOffer({ id: 'B', supplier_id: 2, sid: 'svcB', cost: 1.5, stock: 4, floor: 3 });

// max_profit: display 3.75 (B); fulfil from cheapest cost = A. Mask A stock below B stock.
let d = PricingEngine.decide(product1, [A, B]);
assert.strictEqual(d.displayUnit, 3.75, 'max_profit price = highest sellUnit');
assert.strictEqual(d.fulfillOffer.product_supplier_id, 'A', 'fulfil from cheapest cost');
assert.strictEqual(d.priceOffer.product_supplier_id, 'B');
const maskedA = d.maskedStock.get('A');
assert.ok(maskedA <= 8 && maskedA >= 7 || maskedA < 4, `masked stock ${maskedA} should be below price-offer stock 4 (min(8,4-1)=3)`);
assert.strictEqual(d.maskedStock.get('B'), 4, 'price offer stock shown normally');

// cheapest mode: display = lowest sellUnit (3.00), fulfil still cheapest cost (A)
const productCheapest = { ...product1, pricing_mode: 'cheapest' };
d = PricingEngine.decide(productCheapest, [A, B]);
assert.strictEqual(d.displayUnit, 3, 'cheapest price shown');
assert.strictEqual(d.fulfillOffer.product_supplier_id, 'A');
assert.strictEqual(d.maskedStock.get('A'), 10, 'no masking when price and fulfil are the same offer');

// manual mode
const productManual = { ...product1, pricing_mode: 'manual' };
d = PricingEngine.decide(productManual, [A, B]);
assert.strictEqual(d.displayUnit, 5, 'manual uses product.price');
assert.strictEqual(d.fulfillOffer.product_supplier_id, 'A', 'fulfil still independent');

// sold out: nobody affordable -> soldOut badge, displayUnit null
const A0 = mkOffer({ id: 'A', supplier_id: 1, cost: 0.6, balance: 0 });
const B0 = mkOffer({ id: 'B', supplier_id: 2, cost: 1.5, balance: 0.5 });
d = PricingEngine.decide(product1, [A0, B0]);
assert.strictEqual(d.soldOut, true);
assert.strictEqual(d.displayUnit, null);

// stock below qty not affordable
const A1 = mkOffer({ id: 'A', supplier_id: 1, cost: 0.6, stock: 2 });
d = PricingEngine.decide(product1, [A1]);
assert.strictEqual(d.affordable.length, 1); // qty=1 fine

// maskedStock rules: 2 -> 1, 10 -> 7..8, never above priceOffer-1
for (let i = 0; i < 50; i++) {
  assert.strictEqual(maskedStock(2, 10), 1);
  const m10 = maskedStock(10, null);
  assert.ok(m10 >= 7 && m10 <= 8, `10 -> ${m10}`);
  assert.ok(maskedStock(10, 5) <= 4);
}

// priority fulfilment
const productPriority = { ...product1, supplier_selection_mode: 'priority' };
const Ap = { ...A, priority: 2 };
const Bp = { ...B, priority: 1 };
d = PricingEngine.decide(productPriority, [Ap, Bp]);
assert.strictEqual(d.fulfillOffer.product_supplier_id, 'B', 'priority mode picks lowest priority number');

console.log('PricingEngine unit tests: all passed ✓');
