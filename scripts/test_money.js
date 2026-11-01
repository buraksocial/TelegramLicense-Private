#!/usr/bin/env node
/** Unit tests for src/utils/money.js parse policy (comma is ALWAYS decimal). */
const assert = require('assert');
const { parseMoney, parseQuantity, looksHundredInflated } = require('../src/utils/money');

const moneyCases = [
  // [input, expected]
  ['1,45', 1.45],
  ['74,45', 74.45],      // NOT 7445 — the historic corruption fix
  ['1,450', 1.45],       // comma always decimal, never thousands
  ['1.450', 1.45],       // dot decimal for USD too
  ['1.450 TL', 1450],    // dot = thousands ONLY in TL context
  ['1,450 TL', 1.45],    // TL suffix does not make comma thousands
  ['74.45', 74.45],
  ['0.10', 0.1],
  ['.5', 0.5],
  ['3', 3],
  ['-5', -5],            // leading sign preserved (balance adjust)
  ['+2.50', 2.5],
  ['-1,5', -1.5],
  ['1.234,56', 1234.56], // EU style: dot thousands + comma decimal
  ['1,5$', 1.5],
  [' 12,7 '], // trimmed below
  ['abc', null],
  ['', null],
  ['$3.20', 3.2],
  ['3,20$', 3.2],
  ['12.000', 12],        // dot with 3 digits = decimal => 12.0? policy: dot always decimal for USD
  ['100', 100]
];

let pass = 0, fail = 0;
for (const c of moneyCases) {
  const [input, expected] = c;
  if (expected === undefined) continue;
  try {
    const got = parseMoney(input);
    if (expected === null) assert(got === null || Number.isNaN(got), `expected null, got ${got}`);
    else assert(Math.abs(got - expected) < 1e-9, `expected ${expected}, got ${got}`);
    pass++;
  } catch (e) {
    fail++;
    console.error(`FAIL parseMoney(${JSON.stringify(input)}): ${e.message}`);
  }
}

const qtyCases = [
  ['5', 5],
  ['1.500', 1500],   // dot thousands = quantity context
  ['1,500', 1500],
  ['12', 12],
  ['x', null]
];
for (const [input, expected] of qtyCases) {
  try {
    const got = parseQuantity(input);
    if (expected === null) assert(got === null || Number.isNaN(got), `expected null/NaN, got ${got}`);
    else assert(got === expected, `expected ${expected}, got ${got}`);
    pass++;
  } catch (e) {
    fail++;
    console.error(`FAIL parseQuantity(${JSON.stringify(input)}): ${e.message}`);
  }
}

// inflation heuristic: looksHundredInflated(value, saneMax) => value >= saneMax
try {
  assert(looksHundredInflated(7445, 1000) === true, '7445 over sane max should look 100x');
  assert(looksHundredInflated(74.45, 1000) === false, 'normal values should not look 100x');
  pass += 2;
} catch (e) { fail++; console.error('FAIL looksHundredInflated:', e.message); }

console.log(fail === 0 ? `money tests: ${pass} passed ✓` : `money tests: ${pass} passed, ${fail} FAILED`);
process.exit(fail ? 1 : 0);
