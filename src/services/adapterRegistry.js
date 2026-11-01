/**
 * Adapter registry: supplier.type -> adapter module.
 *
 * New-style adapters expose { fetchCatalog, getBalance, placeOrder(supplier, ctx) }.
 * The legacy AixShopBot userbot adapter has no REST catalog; it is wrapped so
 * the rest of the system can treat it uniformly (catalogless: it can still
 * fulfil orders, but price/stock come from manual tiers only).
 */
const aivault = require('./adapters/aivault');
const cuppon = require('./adapters/cuppon');
const bunny = require('./adapters/bunny');
const lootpaglu = require('./adapters/lootpaglu');
const aiversexhub = require('./adapters/aiversexhub');
const uniqueaizone = require('./adapters/uniqueaizone');
const legacyAix = require('./adapters/aixshopbot');

const aixshopbot = {
  type: 'aixshopbot',
  catalogless: true,
  async fetchCatalog() {
    const err = new Error('aixshopbot is catalogless (userbot adapter)');
    err.code = 'CATALOGLESS';
    throw err;
  },
  getBalance(supplier) {
    return legacyAix.getBalance(supplier);
  },
  async placeOrder(supplier, ctx) {
    const res = await legacyAix.placeOrder(supplier, ctx.quantity);
    const products = res?.products || (Array.isArray(res) ? res : []);
    return { deliveries: products, order_id: res?.order_id || null, spent_usd: null, balance_after: null, raw: res };
  }
};

const REGISTRY = {
  lootpaglu,
  aivault,
  cuppon,
  bunny,
  aiversexhub,
  uniqueaizone,
  aixshopbot
};

function forSupplier(supplier) {
  return REGISTRY[supplier.type] || null;
}

module.exports = { forSupplier, REGISTRY };
