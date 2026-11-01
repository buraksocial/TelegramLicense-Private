#!/usr/bin/env node
const assert = require('assert');
const { scoreMatch } = require('../src/services/CatalogMatcher');
assert.ok(scoreMatch('Gemini Pro 18 Month', 'Google Gemini AI PRO Plan 18M') > 0.8);
assert.ok(scoreMatch('Gemini Pro 3 Month', 'Google Gemini AI PRO Plan 18M') < 0.8);
assert.ok(scoreMatch('Spotify 2M Redeem Link', 'Spotify 2M Redeem Link') >= 0.9);
assert.ok(scoreMatch('Netflix 1M 4K HDR', 'Apple Music 5M') < 0.5);
assert.ok(scoreMatch('Apple Music 5 Months', 'Apple Music 5M') > 0.85);
assert.ok(scoreMatch('Adobe Express Premium 12M', 'Adobe Express 12M') > 0.8);
console.log('matcher tests OK');
