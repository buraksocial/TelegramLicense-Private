/** Publish a curated storefront catalog from supplier snapshots (no live API calls). */
const { classifyWarranty } = require('../../utils/warranty');

const MARGIN = 150;
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

function cleanName(name) {
  let value = norm(name)
    .replace(/\b(?:chat ?gpt|gpt)\b/g, 'chatgpt').replace(/\bgoogle\s+veo\b/g, 'veo')
    .replace(/\b(?:google ai|gemini ai)\b/g, 'gemini').replace(/\bprime vedio\b/g, 'prime video');
  value = value.replace(/\b(\d+)\s*(?:million|m)\s*(?:credits?|tokens?)\b/g, '$1m credits')
    .replace(/\b(\d+)\s*(?:billion|b)\s*tokens?\b/g, '$1b tokens')
    .replace(/\b(\d+)\s*(?:years?|year|yr|y)\b/g, (_, n) => `${Number(n) * 12} month`)
    .replace(/\b(\d+)\s*(?:months?|month|mo)\b/g, '$1 month')
    .replace(/\b(\d+)\s*m(?!\s*(?:credits?|tokens?))\b/g, '$1 month')
    .replace(/\b(\d+)\s*(?:days?|day|d)\b/g, '$1 day');
  return value.replace(/\b(?:account delivery|full account|ready made account|ready account|account|coupon link|coupon|offer link|activation link|redeem link|redeem|link|invite|team invite|fw|nw|upi|card required|global|private|fresh|good quality|high quality|genuine|no api only web)\b/g, ' ')
    .replace(/\b(?:api|service|subscription|plan)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function monthDuration(name) {
  const m = name.match(/\b(\d+)\s*month\b/);
  return m ? `${m[1]}-months` : null;
}
function durationName(duration) {
  if (!duration) return { tr: 'Diğer Paketler', en: 'Other Plans' };
  const amount = Number(duration.split('-')[0]);
  return { tr: `${amount} Ay`, en: `${amount} Months` };
}
function title(clean) {
  return clean.split(' ').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}
function tier(name) {
  return (name.match(/\b(pro|plus|ultra|basic|premium|business|creator|core|starter|enterprise|edu|career|student)\b/) || [])[1] || 'standard';
}
function classify(name) {
  const text = cleanName(name);
  if (/\b(chatgpt|claude|gemini)\b/.test(text) && /\b(full|combo)\b/.test(text)) return { root: 'ai', brand: 'ai-bundle', tier: 'standard' };
  const known = [
    ['gemini', /gemini|\bveo\b/], ['chatgpt', /chatgpt|openai|codex/], ['claude', /claude/],
    ['deepseek', /deepseek/], ['muse-ai', /muse ai/], ['spotify', /spotify/], ['apple-music', /apple music/],
    ['adobe', /adobe/], ['duolingo', /duolingo/], ['notion', /notion/], ['canva', /canva/],
    ['elevenlabs', /eleven ?labs|eleven reader/], ['microsoft', /microsoft|office|windows/],
    ['youtube', /youtube/], ['amazon-prime', /amazon prime|prime video/], ['netflix', /netflix/],
    ['capcut', /capcut/], ['linkedin', /linkedin/], ['wispr-flow', /wispr flow/],
    ['gmail', /gmail|google mail|hotmail|outlook mail|icloud mail/], ['vpn', /vpn|proxy/]
  ];
  const matched = known.find(([, re]) => re.test(text));
  let root = 'other';
  if (/gemini|veo|chatgpt|openai|claude|deepseek|muse ai|codex/.test(text)) root = 'ai';
  else if (/spotify|apple music|netflix|youtube|prime video|amazon prime|crunchyroll|apple tv/.test(text)) root = 'streaming';
  else if (/vpn|proxy/.test(text)) root = 'vpn';
  else if (/windows|office|microsoft|adobe|autodesk|software|jetbrain|github|cursor|notion|figma|canva|framer|replit|supabase|linear|resend|railway|grammarly|ilovepdf/.test(text)) root = 'software';
  else if (/steam|game|xbox|playstation/.test(text)) root = 'games';
  else if (/gmail|hotmail|outlook|icloud|account|instagram|linkedin/.test(text)) root = 'accounts';
  const brand = matched ? matched[0] : (text.split(' ')[0] || 'other');
  return { root, brand, tier: tier(text), duration: monthDuration(text) };
}

const roots = {
  ai: { tr: 'AI & Yapay Zeka', en: 'AI & Artificial Intelligence' },
  streaming: { tr: 'Dijital Platformlar', en: 'Streaming' }, software: { tr: 'Yazılım', en: 'Software' },
  vpn: { tr: 'VPN & Güvenlik', en: 'VPN & Security' }, games: { tr: 'Oyunlar', en: 'Games' },
  accounts: { tr: 'Hesaplar', en: 'Accounts' }, other: { tr: 'Diğer', en: 'Other' }
};

function addCategory(db, parentId, slug, names, sort) {
  const found = db.prepare('SELECT id FROM categories WHERE slug=?').get(slug);
  if (found) return found.id;
  return Number(db.prepare(`INSERT INTO categories(parent_id,slug,name_json,emoji,sort_order,is_active)
    VALUES(?,?,?,'📦',?,1)`).run(parentId, slug, JSON.stringify(names), sort).lastInsertRowid);
}
function productKey(name) {
  const clean = cleanName(name);
  return `${clean.replace(/\b\d+\s*(?:month|day)\b/g, ' ').replace(/\s+/g, ' ').trim()}|${monthDuration(clean) || 'unspecified'}`;
}
function localizedJson(text, tr) { return JSON.stringify({ en: text, tr }); }

module.exports = {
  label: 'curated supplier catalog with fixed 150 percent margin',
  up(db) {
    const rows = db.prepare(`SELECT sc.*, s.name supplier_name FROM supplier_catalogs sc
      JOIN suppliers s ON s.id=sc.supplier_id WHERE s.enabled=1 ORDER BY sc.supplier_id,sc.remote_service_id`).all();
    const groups = new Map();
    for (const row of rows) {
      const cost = Number(row.price_usd);
      const cleaned = cleanName(row.name);
      if (!Number.isFinite(cost) || cost <= 0 || !cleaned || /^\d+$/.test(cleaned) || cleaned.length < 3) continue;
      const key = productKey(row.name);
      if (!groups.has(key)) groups.set(key, { key, title: title(cleaned), cat: classify(row.name), offers: [] });
      groups.get(key).offers.push({ row, cost });
    }

    const transaction = db.transaction(() => {
      for (const group of groups.values()) {
        const { cat } = group;
        const rootId = addCategory(db, null, cat.root, roots[cat.root], 10);
        const brandSlug = `${cat.root}-${norm(cat.brand).replace(/ /g, '-')}`;
        const brandName = cat.brand.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        const brandId = addCategory(db, rootId, brandSlug, { tr: brandName, en: brandName }, 20);
        const tierId = addCategory(db, brandId, `${brandSlug}-${cat.tier}`, { tr: cat.tier, en: cat.tier }, 30);
        const duration = group.offers.map((x) => monthDuration(cleanName(x.row.name))).filter(Boolean).sort((a,b)=>Number(a)-Number(b))[0] || cat.duration;
        const leaf = durationName(duration);
        const categoryId = addCategory(db, tierId, `${brandSlug}-${cat.tier}-${duration || 'other-plans'}`.replace(/[^a-z0-9-]/g, '-'), leaf, 40);
        let product = db.prepare('SELECT * FROM products WHERE is_active=1').all().find((p) => {
          let existing; try { existing = JSON.parse(p.name).en || JSON.parse(p.name).tr; } catch { existing = p.name; }
          return productKey(existing) === group.key;
        });
        const cost = Math.min(...group.offers.map((x) => x.cost));
        const price = Math.round(cost * (1 + MARGIN / 100) * 100) / 100;
        const warranty = classifyWarranty(group.offers.map((x) => `${x.row.name} ${x.row.description || ''}`).join(' '));
        const nameJson = localizedJson(group.title, group.title.replace(/\bmonths?\b/gi, 'Ay').replace(/\bdays?\b/gi, 'Gün'));
        const descEn = `${group.title}. Digital service delivered after payment. Verify the plan and duration before ordering.`;
        const descTr = `${group.title}. Ödeme sonrasında teslim edilen dijital hizmettir. Sipariş öncesinde paket ve süreyi kontrol edin.`;
        const descriptionJson = localizedJson(descEn, descTr);
        if (!product) {
          const result = db.prepare(`INSERT INTO products
            (name,description,price,cost_usd,pricing_mode,warranty,default_margin_percent,default_floor_price,
             supplier_selection_mode,is_active,hidden_when_unaffordable,auto_copy_done)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,1)`).run(nameJson, descriptionJson, price, cost, 'cheapest', warranty, MARGIN, 0, 'cheapest', 1, 0);
          product = db.prepare('SELECT * FROM products WHERE id=?').get(result.lastInsertRowid);
        } else {
          // Curated catalog is authoritative for price/margin, but preserve
          // existing localized/manual title and copy.
          db.prepare(`UPDATE products SET cost_usd=?,price=?,pricing_mode='cheapest',default_margin_percent=?,
            default_floor_price=0,warranty=? WHERE id=?`).run(cost, price, MARGIN, warranty, product.id);
        }
        db.prepare('INSERT OR IGNORE INTO product_categories(product_id,category_id) VALUES(?,?)').run(product.id, categoryId);
        for (const { row, cost: offerCost } of group.offers) {
          const link = db.prepare('SELECT id FROM product_suppliers WHERE supplier_id=? AND remote_service_id=?').get(row.supplier_id, row.remote_service_id);
          if (link) {
            db.prepare(`UPDATE product_suppliers SET product_id=?,last_price_usd=?,last_stock=?,enabled=1,note='curated' WHERE id=?`)
              .run(product.id, offerCost, row.stock, link.id);
          } else {
            const priority = db.prepare('SELECT COALESCE(MAX(priority),0)+1 p FROM product_suppliers WHERE product_id=?').get(product.id).p;
            db.prepare(`INSERT INTO product_suppliers(product_id,supplier_id,remote_service_id,priority,warranty,last_price_usd,last_stock,note)
              VALUES(?,?,?,?,?,?,?,'curated')`).run(product.id, row.supplier_id, row.remote_service_id, priority, row.warranty || 'auto', offerCost, row.stock);
          }
        }
      }
    });
    transaction();
  }
};
