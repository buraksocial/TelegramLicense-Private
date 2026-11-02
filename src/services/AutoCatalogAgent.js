/**
 * AutoCatalogAgent — turns every new supplier service into a local product or
 * merges it into the closest existing product. It only reads snapshots; the
 * normal PricingEngine still decides price and fulfilment at checkout.
 */
const { db } = require('../db');
const CatalogMatcher = require('./CatalogMatcher');
const { warrantyAllows } = require('../utils/warranty');
const TranslationService = require('./TranslationService');

function cleanText(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/(?:t\.me|telegram\.me)\/\S+/gi, '')
    .replace(/\b(?:api|bot|supplier|tedarikçi)\s*[:=-]?\s*[^,;\n]*/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

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
  const rules = {
    ai: /gemini|chatgpt|claude|\bai\b|yapay zek/,
    streaming: /netflix|spotify|disney|youtube|prime video|canva/,
    vpn: /vpn|proxy|nord|surfshark|expressvpn/,
    software: /windows|office|adobe|autocad|software|yazılım/,
    games: /game|steam| oyun|xbox|playstation/,
    accounts: /account|hesap|üyelik/
  };
  const match = Object.entries(rules).find(([, re]) => re.test(text));
  return (match && cats.find((c) => c.slug === match[0])) || cats.find((c) => c.slug === 'other') ||
    cats.find((c) => c.slug && c.slug.split(/[^a-z0-9çğıöşü]+/).filter(Boolean).some((w) => w.length > 2 && text.includes(w))) || null;
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

async function productCopy(supplier, service) {
  const langs = db.prepare('SELECT code FROM languages WHERE enabled=1 ORDER BY sort_order').all().map((r) => r.code);
  const baseLangs = ['en', ...langs].filter((l, i, a) => a.indexOf(l) === i);
  const sourceName = cleanText(service.name);
  const sourceDesc = cleanText(service.description);
  let copies = {};
  try {
    copies = await TranslationService.generateProductCopy(sourceName, sourceDesc, baseLangs, 'Do not reveal suppliers, bots, API URLs, contact links or internal sources.');
  } catch (e) { console.error('[AutoCatalogAgent] copy generation:', e.message); }
  const names = {}; const descs = {};
  for (const lang of baseLangs) {
    names[lang] = cleanText(copies[lang]?.name || sourceName);
    descs[lang] = cleanText(copies[lang]?.description || sourceDesc);
  }
  return { names, descs };
}

async function createProduct(supplier, service) {
  const category = categoryFor(service.name, service.category_raw);
  const margin = category && category.default_margin_percent != null
    ? Number(category.default_margin_percent) : setting('auto_import_margin_percent', 150);
  const floor = category && category.default_floor_price != null
    ? Number(category.default_floor_price) : setting('auto_import_floor_price', 2);
  const cost = Number(service.price_usd || 0);
  const sell = Math.max(cost * (1 + margin / 100), floor);
  const { names, descs } = await productCopy(supplier, service);
  const info = db.prepare(`INSERT INTO products
    (name, description, price, cost_usd, pricing_mode, warranty, default_margin_percent,
    default_floor_price, supplier_selection_mode, is_active, hidden_when_unaffordable, auto_copy_done)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    JSON.stringify(names), JSON.stringify(descs), Math.round(sell * 100) / 100, cost,
    'max_profit', service.warranty || 'none', margin, floor, 'cheapest', 1, 0, 1
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

async function repairExisting(supplier, services) {
  const pending = db.prepare(`SELECT p.*, ps.remote_service_id FROM products p
    JOIN product_suppliers ps ON ps.product_id=p.id
    WHERE ps.supplier_id=? AND ps.note='auto-import' AND COALESCE(p.auto_copy_done,0)=0`).all(supplier.id);
  let repaired = 0;
  for (const p of pending) {
    const service = (services || []).find((s) => String(s.remote_service_id) === String(p.remote_service_id));
    if (!service) continue;
    const { names, descs } = await productCopy(supplier, service);
    db.prepare('UPDATE products SET name=?, description=?, auto_copy_done=1 WHERE id=?')
      .run(JSON.stringify(names), JSON.stringify(descs), p.id);
    const category = categoryFor(service.name, service.category_raw);
    if (category) db.prepare('INSERT OR IGNORE INTO product_categories (product_id,category_id) VALUES (?,?)').run(p.id, category.id);
    repaired++;
  }
  return repaired;
}

async function syncSupplier(supplier, services) {
  let created = 0; let linked = 0;
  for (const service of services || []) {
      if (!service || !service.remote_service_id || !service.name) continue;
      let product = findOwner(service);
      if (!product) { product = await createProduct(supplier, service); created++; }
      if (link(product, supplier, service)) linked++;
  }
  const repaired = await repairExisting(supplier, services);
  if (created || linked || repaired) console.log(`[AutoCatalogAgent] ${supplier.name}: ${created} ürün, ${linked} bağlantı, ${repaired} onarım`);
  return { created, linked, repaired };
}

module.exports = { syncSupplier };
