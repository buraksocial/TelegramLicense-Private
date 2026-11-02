/**
 * AutoCatalogAgent — turns every new supplier service into a local product or
 * merges it into the closest existing product. It only reads snapshots; the
 * normal PricingEngine still decides price and fulfilment at checkout.
 */
const { db } = require('../db');
const CatalogMatcher = require('./CatalogMatcher');
const { warrantyAllows } = require('../utils/warranty');

function setting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function productName(product) {
  try {
    const j = JSON.parse(product.name);
    return j.en || j.tr || product.name;
  } catch (e) { return product.name || ''; }
}

function categoryFor(name, raw) {
  const text = `${name} ${raw || ''}`.toLowerCase();
  const cats = db.prepare('SELECT * FROM categories WHERE is_active=1 ORDER BY sort_order,id').all();
  return cats.find((c) => c.slug && c.slug.split(/[^a-z0-9çğıöşü]+/).filter(Boolean)
    .some((w) => w.length > 2 && text.includes(w))) || null;
}

function findOwner(service) {
  const products = db.prepare('SELECT * FROM products WHERE is_active=1').all();
  let owner = null; let score = 0;
  for (const p of products) {
    if (p.warranty && p.warranty !== 'none' && !warrantyAllows(p.warranty, service.warranty || 'unknown')) continue;
    const s = CatalogMatcher.scoreMatch(service.name || '', productName(p));
    if (s > score) { score = s; owner = p; }
  }
  return score >= 0.72 ? owner : null;
}

function createProduct(supplier, service) {
  const category = categoryFor(service.name, service.category_raw);
  const margin = category && category.default_margin_percent != null
    ? Number(category.default_margin_percent) : setting('auto_import_margin_percent', 150);
  const floor = category && category.default_floor_price != null
    ? Number(category.default_floor_price) : setting('auto_import_floor_price', 2);
  const cost = Number(service.price_usd || 0);
  const sell = Math.max(cost * (1 + margin / 100), floor);
  const names = { en: service.name || `${supplier.name} service`, tr: service.name || `${supplier.name} hizmeti` };
  const descs = { en: service.description || '', tr: service.description || '' };
  const info = db.prepare(`INSERT INTO products
    (name, description, price, cost_usd, pricing_mode, warranty, default_margin_percent,
     default_floor_price, supplier_selection_mode, is_active, hidden_when_unaffordable)
    VALUES (?,?,?,?,?,?,?,?,?,?,0)`).run(
    JSON.stringify(names), JSON.stringify(descs), Math.round(sell * 100) / 100, cost,
    'max_profit', service.warranty || 'none', margin, floor, 'cheapest', 1
  );
  const id = info.lastInsertRowid;
  if (category) db.prepare('INSERT OR IGNORE INTO product_categories (product_id, category_id) VALUES (?,?)').run(id, category.id);
  return db.prepare('SELECT * FROM products WHERE id=?').get(id);
}

function link(product, supplier, service) {
  const exists = db.prepare('SELECT id FROM product_suppliers WHERE supplier_id=? AND remote_service_id=?')
    .get(supplier.id, String(service.remote_service_id));
  if (exists) return false;
  const priority = (db.prepare('SELECT COALESCE(MAX(priority),0)+1 p FROM product_suppliers WHERE product_id=?')
    .get(product.id).p) || 1;
  db.prepare(`INSERT INTO product_suppliers
    (product_id,supplier_id,remote_service_id,priority,margin_percent,floor_price,warranty,last_price_usd,last_stock,note)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    product.id, supplier.id, String(service.remote_service_id), priority, null, null,
    service.warranty || 'auto', service.price_usd ?? null, service.stock ?? null, 'auto-import'
  );
  return true;
}

async function syncSupplier(supplier, services) {
  let created = 0; let linked = 0;
  const tx = db.transaction(() => {
    for (const service of services || []) {
      if (!service || !service.remote_service_id || !service.name) continue;
      let product = findOwner(service);
      if (!product) { product = createProduct(supplier, service); created++; }
      if (link(product, supplier, service)) linked++;
    }
  });
  tx();
  if (created || linked) console.log(`[AutoCatalogAgent] ${supplier.name}: ${created} ürün, ${linked} bağlantı`);
  return { created, linked };
}

module.exports = { syncSupplier };
