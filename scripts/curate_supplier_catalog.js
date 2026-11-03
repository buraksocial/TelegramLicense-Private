#!/usr/bin/env node
/**
 * One-time, deliberate publication of supplier catalog rows.
 * Polling only refreshes supplier_catalogs; this command is the only bulk
 * publisher. It is idempotent and preserves orders, manual edits and links.
 */
const { db } = require('../src/db');
const CatalogStore = require('../src/services/CatalogStore');
const { classifyWarranty } = require('../src/utils/warranty');
const TranslationService = require('../src/services/TranslationService').TranslationService;

const MARGIN = 150;
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const aliases = [
  ['google veo', 'veo'], ['veo 3', 'veo 3'], ['google ai', 'gemini'],
  ['youtube', 'youtube'], ['prime vedio', 'prime video'], ['reedem', 'redeem'],
  ['capcut', 'capcut'], ['duolingo super', 'duolingo super'], ['gemini ai', 'gemini']
];
const stripTerms = /\b(?:account delivery|full account|ready made account|ready account|account|coupon link|coupon|offer link|activation link|redeem link|redeem|link|invite|team invite|fw|nw|upi|card required|global|private|fresh|good quality|high quality|genuine|no api only web)\b/g;

function cleanName(name) {
  let value = norm(name);
  for (const [from, to] of aliases) value = value.replace(new RegExp(`\\b${from.replace(/ /g, '\\s+')}\\b`, 'g'), to);
  // Normalize credit/token quantities before shorthand `m` can be read as months.
  value = value.replace(/\b(\d+)\s*(?:million|m)\s*(?:credits?|tokens?)\b/g, '$1m credits')
    .replace(/\b(\d+)\s*(?:billion|b)\s*tokens?\b/g, '$1b tokens')
    .replace(/\b(\d+)\s*(?:months?|month|mo|m(?!\s*(?:credits?|tokens?)))\b/g, '$1 month')
    .replace(/\b(\d+)\s*(?:years?|year|yr|y)\b/g, (_, n) => `${Number(n) * 12} month`)
    .replace(/\b(\d+)\s*(?:days?|day|d)\b/g, (_, n) => Number(n) % 30 === 0 ? `${Number(n) / 30} month` : `${n} day`);
  value = value.replace(stripTerms, ' ').replace(/\b(?:api|service|subscription|plan)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return value;
}

function canonicalTitle(cleaned) {
  const keep = cleaned.split(' ').filter(Boolean);
  return keep.map((w) => /^(\d+)(month|day|m|b|million|billion)$/.test(w) ? w : w[0].toUpperCase() + w.slice(1)).join(' ');
}

function duration(text) {
  const m = text.match(/\b(\d+)\s*(month|day)\b/);
  return m ? `${m[1]}-${m[2]}s` : 'duration-unspecified';
}
function term(text) {
  return (text.match(/\b(pro|plus|ultra|basic|premium|business|creator|core|starter|enterprise|edu|career|student)\b/) || [])[1] || 'standard';
}
function sku(name) {
  const clean = cleanName(name);
  const durationKey = duration(clean);
  const rest = clean.replace(/\b\d+\s*(?:month|day)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return `${rest}|${durationKey}`;
}

const brands = [
  ['gemini', /\bgemini\b|\bveo\b/], ['chatgpt', /chatgpt|openai|codex/], ['claude', /claude/],
  ['deepseek', /deepseek/], ['muse-ai', /muse ai/], ['spotify', /spotify/], ['apple-music', /apple music/],
  ['adobe', /adobe/], ['duolingo', /duolingo/], ['notion', /notion/], ['canva', /canva/],
  ['elevenlabs', /eleven ?labs|eleven reader/], ['microsoft', /microsoft|office|windows/],
  ['youtube', /youtube/], ['amazon-prime', /amazon prime|prime video/], ['netflix', /netflix/],
  ['vpn', /vpn|proxy/], ['gmail', /gmail|google mail|hotmail|outlook mail|icloud mail/],
  ['capcut', /capcut/], ['linkedin', /linkedin/], ['notion', /notion/], ['wispr-flow', /wispr flow/]
];
function classify(name) {
  const text = cleanName(name);
  if (/\b(?:chatgpt|claude|gemini)\b/.test(text) && /\b(?:full|combo)\b/.test(text)) {
    return { root: 'ai', brand: 'ai-bundle', tier: 'standard', duration: duration(text) };
  }
  const brand = brands.find(([, re]) => re.test(text));
  let root = 'other';
  if (/gemini|veo|chatgpt|openai|claude|deepseek|muse ai|codex|api/.test(text)) root = 'ai';
  else if (/spotify|apple music|netflix|youtube|prime video|amazon prime|crunchyroll|apple tv/.test(text)) root = 'streaming';
  else if (/vpn|proxy/.test(text)) root = 'vpn';
  else if (/windows|office|microsoft|adobe|autodesk|software|jetbrain|github|cursor|notion|figma|canva|framer|replit|supabase|linear|resend|railway|grammarly|ilovepdf/.test(text)) root = 'software';
  else if (/steam|game|xbox|playstation/.test(text)) root = 'games';
  else if (/gmail|hotmail|outlook|icloud|account|instagram|linkedin/.test(text)) root = 'accounts';
  const rawBrand = brand ? brand[0] : text.split(' ')[0] || 'other';
  const tier = term(text);
  return { root, brand: root === 'ai' ? rawBrand : rawBrand, tier, duration: duration(cleanName(name)) };
}

const rootNames = {
  ai: ['AI & Yapay Zeka', 'AI & Artificial Intelligence'], streaming: ['Dijital Platformlar', 'Streaming'],
  software: ['Yazılım', 'Software'], vpn: ['VPN & Güvenlik', 'VPN & Security'],
  games: ['Oyunlar', 'Games'], accounts: ['Hesaplar', 'Accounts'], other: ['Diğer', 'Other']
};
function ensureCategory(parentId, slug, tr, en, sort) {
  let row = db.prepare('SELECT id FROM categories WHERE slug=?').get(slug);
  if (row) return row.id;
  return Number(db.prepare(`INSERT INTO categories(parent_id,slug,name_json,emoji,sort_order,is_active)
    VALUES(?,?,?, ?, ?,1)`).run(parentId, slug, JSON.stringify({ tr, en }), '📦', sort || 100).lastInsertRowid);
}
function titleJson(en) {
  return JSON.stringify({ en, tr: en.replace(/\b(months?|month)\b/gi, 'Ay').replace(/\bdays?\b/gi, 'Gün') });
}
function durationNames(duration) {
  if (duration === 'duration-unspecified') return { en: 'Standard', tr: 'Standart' };
  const m = duration.match(/^(\d+)-(months|days)$/);
  if (!m) return { en: duration, tr: duration };
  return { en: `${m[1]} ${m[2]}`, tr: `${m[1]} ${m[2] === 'months' ? 'Ay' : 'Gün'}` };
}
function descriptionJson(en) {
  return JSON.stringify({
    en: `Official ${en} digital service. Delivery is handled after payment. Please check the plan and duration before ordering.`,
    tr: `${en} dijital hizmeti. Teslimat ödeme sonrası yapılır. Sipariş vermeden önce paket ve süre bilgisini kontrol edin.`,
  });
}

async function main() {
  if (!process.argv.includes('--apply')) {
    console.log('DRY RUN only. Run with --apply to publish curated products.');
  }
  const apply = process.argv.includes('--apply');
  const suppliers = db.prepare('SELECT * FROM suppliers WHERE enabled=1 ORDER BY id').all();
  for (const supplier of suppliers) {
    if (supplier.type === 'aixshopbot') continue; // catalogless, cannot curate via catalog API
    try { await CatalogStore.getCatalog(supplier, { force: true }); }
    catch (e) { console.warn(`[catalog] ${supplier.name}: ${e.message}`); }
  }
  const services = db.prepare(`SELECT sc.*, s.name supplier_name FROM supplier_catalogs sc
    JOIN suppliers s ON s.id=sc.supplier_id WHERE s.enabled=1 ORDER BY sc.supplier_id,sc.remote_service_id`).all();
  const groups = new Map();
  for (const row of services) {
    const cost = Number(row.price_usd);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    const normalized = cleanName(row.name);
    // Do not publish malformed supplier rows such as a bare numeric id or
    // rows that contain no recognizable product words.
    if (!normalized || /^\d+$/.test(normalized) || normalized.length < 3) continue;
    const key = sku(row.name);
    if (!groups.has(key)) groups.set(key, { key, title: canonicalTitle(normalized), category: classify(row.name), offers: [] });
    groups.get(key).offers.push({ row, cost });
  }
  console.log(`Catalog rows: ${services.length}; sellable SKU groups: ${groups.size}`);
  if (!apply) {
    for (const g of groups.values()) console.log(`${g.category.root}/${g.category.brand}/${g.category.tier}/${g.category.duration} | ${g.title} | offers=${g.offers.length} | from=$${Math.min(...g.offers.map(o=>o.cost))}`);
    return;
  }

  const summary = { created: 0, updated: 0, links: 0, skipped: 0 };
  const transaction = db.transaction(() => {
    for (const group of groups.values()) {
      const cat = group.category;
      const rootCat = db.prepare('SELECT id FROM categories WHERE slug=?').get(cat.root);
      const rootId = rootCat ? rootCat.id : ensureCategory(null, cat.root, ...(rootNames[cat.root] || rootNames.other), 10);
      const brandSlug = `${cat.root}-${norm(cat.brand).replace(/ /g, '-')}`;
      const brandId = ensureCategory(rootId, brandSlug, cat.brand.replace(/-/g, ' '), cat.brand.replace(/-/g, ' '), 20);
      let parentId = brandId;
      if (cat.root === 'ai') {
        const tierId = ensureCategory(brandId, `${brandSlug}-${cat.tier}`, cat.tier, cat.tier, 30);
        parentId = tierId;
      }
      if (cat.root !== 'ai') {
        parentId = ensureCategory(brandId, `${brandSlug}-${cat.tier}`, cat.tier, cat.tier, 30);
      }
      const leafSlug = `${brandSlug}-${cat.tier}-${cat.duration}`.replace(/[^a-z0-9-]/g, '-');
      const leafName = durationNames(cat.duration);
      const categoryId = ensureCategory(parentId, leafSlug, leafName.tr, leafName.en, 40);

      let product = db.prepare('SELECT * FROM products WHERE is_active=1').all().find((p) => sku((() => { try { const j=JSON.parse(p.name); return j.en||j.tr; } catch { return p.name; } })()) === group.key);
      const cost = Math.min(...group.offers.map((o) => o.cost));
      const sell = Math.round(cost * (1 + MARGIN / 100) * 100) / 100;
      const warranty = classifyWarranty(group.offers.map((o) => `${o.row.name} ${o.row.description || ''}`).join(' '));
      if (!product) {
        const inserted = db.prepare(`INSERT INTO products
          (name,description,price,cost_usd,pricing_mode,warranty,default_margin_percent,default_floor_price,
           supplier_selection_mode,is_active,hidden_when_unaffordable,auto_copy_done)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,1)`).run(titleJson(group.title), descriptionJson(group.title), sell, cost,
          'cheapest', warranty, MARGIN, 0, 'cheapest', 1, 0);
        product = db.prepare('SELECT * FROM products WHERE id=?').get(inserted.lastInsertRowid);
        summary.created++;
        TranslationService.enqueue('product', product.id, 'name', group.title, 'curated_catalog');
        TranslationService.enqueue('product', product.id, 'description', JSON.parse(product.description).en, 'curated_catalog');
      } else {
        db.prepare(`UPDATE products SET pricing_mode='cheapest',default_margin_percent=?,default_floor_price=0,
          cost_usd=?,price=?,warranty=? WHERE id=?`).run(MARGIN, cost, sell, warranty, product.id);
        summary.updated++;
      }
      const title = JSON.parse(titleJson(group.title));
      const description = JSON.parse(descriptionJson(group.title));
      const existingName = (() => { try { return JSON.parse(product.name); } catch { return { en: product.name }; } })();
      const existingDesc = (() => { try { return JSON.parse(product.description || '{}'); } catch { return { en: product.description }; } })();
      if (!existingName.tr) existingName.tr = title.tr;
      if (!existingDesc.en) existingDesc.en = description.en;
      if (!existingDesc.tr) existingDesc.tr = description.tr;
      db.prepare('UPDATE products SET name=?,description=? WHERE id=?')
        .run(JSON.stringify(existingName), JSON.stringify(existingDesc), product.id);
      TranslationService.enqueue('product', product.id, 'name', existingName.en || group.title, 'curated_catalog');
      TranslationService.enqueue('product', product.id, 'description', existingDesc.en || description.en, 'curated_catalog');
      db.prepare('INSERT OR IGNORE INTO product_categories(product_id,category_id) VALUES(?,?)').run(product.id, categoryId);
      for (const offer of group.offers) {
        const r = offer.row;
        const exists = db.prepare('SELECT id FROM product_suppliers WHERE supplier_id=? AND remote_service_id=?').get(r.supplier_id, r.remote_service_id);
        if (exists) {
          db.prepare(`UPDATE product_suppliers SET product_id=?,last_price_usd=?,last_stock=?,note='curated',enabled=1 WHERE id=?`)
            .run(product.id, offer.cost, r.stock, exists.id);
        } else {
          const priority = db.prepare('SELECT COALESCE(MAX(priority),0)+1 p FROM product_suppliers WHERE product_id=?').get(product.id).p;
          db.prepare(`INSERT INTO product_suppliers
            (product_id,supplier_id,remote_service_id,priority,margin_percent,floor_price,warranty,last_price_usd,last_stock,note)
            VALUES(?,?,?,?,NULL,NULL,?,?,?,'curated')`).run(product.id, r.supplier_id, r.remote_service_id,
            priority, r.warranty || 'auto', offer.cost, r.stock);
          summary.links++;
        }
      }
    }
  });
  transaction();
  console.log(JSON.stringify(summary));
  console.log('Translations queued for the existing background translation agent.');
}

main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
