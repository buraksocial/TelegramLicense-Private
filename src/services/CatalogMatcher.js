/**
 * CatalogMatcher — proposes product_matches rows (supplier service -> local
 * product) for the admin approval queue.
 *
 * Matching is heuristic but tuned for this catalogue's vocabulary:
 *   brand (Gemini/Spotify/Netflix...) 50 pts, duration 30 pts, plan 20 pts.
 * Nothing is auto-linked: every candidate lands as `pending` and the admin
 * approves/rejects from the admin panel; approval creates the product_suppliers
 * link. score >= AUTO_APPROVE (default 0.95) is still shown for approval —
 * wrong matches cost real money, so the human stays in the loop.
 */
const { db } = require('../db');
const { hashText } = require('./TranslationService');

const BRANDS = [
  'gemini', 'chatgpt', 'gpt', 'openai', 'claude', 'copilot', 'cursor',
  'spotify', 'youtube', 'netflix', 'apple music', 'apple one', 'icloud',
  'adobe', 'photoshop', 'illustrator', 'premiere', 'express', 'acrobat',
  'duolingo', 'canva', 'figma', 'notion', 'microsoft', 'office', 'onedrive',
  'nordvpn', 'expressvpn', 'surfhark', 'autocad', 'blender', 'iptv', 'nord'
];

const PLANS = ['pro', 'premium', 'standard', 'family', 'individual', 'student', 'single', 'ultra', 'max', 'basic'];

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[<>"'`]/g, ' ')
    .replace(/\bs\b/g, '')
    // "18 months", "18 month", "18mo", "18m", "18 aylık" -> "18m"
    .replace(/(\d+)\s*(?:months?|month|mo|m|aylık|ay|meses|mois|monate|mese|个月|महीने|ماه)\b/gi, '$1m ')
    // "2 years", "2y" -> "24m"
    .replace(/(\d+)\s*(?:years?|y|yıl|ans|jahre|年|वर्ष)\b/g, (mm, n) => `${parseInt(n, 10) * 12}m `)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function brandsOf(s) {
  const set = new Set();
  for (const b of BRANDS) if (s.includes(b)) set.add(b === 'gpt' || b === 'openai' ? 'chatgpt' : b);
  return set;
}

function durationOf(s) {
  const m = s.match(/(\d+)\s*m\b/g) || [];
  const months = m.map((x) => parseInt(x, 10));
  const y = s.match(/(\d+)\s*y\b/g) || [];
  for (const x of y) months.push(parseInt(x, 10) * 12);
  // bare "12 " patterns like "12 Month" already captured; "3M" captured
  return months.length ? Math.max(...months) : null;
}

function planOf(s) {
  for (const p of PLANS) if (new RegExp(`\\b${p}\\b`).test(s)) return p;
  return null;
}

/** Score one remote service name against one local product name (0..1). */
function scoreMatch(remoteName, productName) {
  const a = normalize(remoteName);
  const b = normalize(productName);
  const ba = brandsOf(a);
  const bb = brandsOf(b);

  const brandOverlap = [...ba].filter((x) => bb.has(x)).length;
  const brandTotal = Math.max(ba.size, bb.size, 1);
  const brandScore = brandOverlap / brandTotal; // 0..1

  const da = durationOf(a);
  const dbb = durationOf(b);
  let durScore = 0.5; // unknown duration on either side -> neutral half
  if (da !== null && dbb !== null) {
    const ratio = Math.min(da, dbb) / Math.max(da, dbb);
    durScore = ratio >= 0.99 ? 1 : ratio >= 0.5 ? 0.4 : 0.1;
  }

  const pa = planOf(a);
  const pb = planOf(b);
  let planScore = 0.5;
  if (pa && pb) planScore = pa === pb ? 1 : 0.2;

  return Math.round((brandScore * 0.5 + durScore * 0.3 + planScore * 0.2) * 100) / 100;
}

function productNameEn(p) {
  try {
    const j = JSON.parse(p.name);
    return j.en || Object.values(j)[0];
  } catch (e) {
    return p.name;
  }
}

class CatalogMatcher {
  /**
   * Scan every enabled supplier's snapshot; upsert candidate matches into
   * product_matches. Existing approved links are never downgraded.
   * @returns {{pending:number, updated:number}}
   */
  static suggest() {
    const products = db.prepare('SELECT * FROM products WHERE is_active = 1').all();
    const catalogs = db
      .prepare(
        `SELECT sc.*, s.enabled FROM supplier_catalogs sc JOIN suppliers s ON s.id = sc.supplier_id WHERE s.enabled = 1`
      )
      .all();

    const getMatch = db.prepare('SELECT * FROM product_matches WHERE supplier_id = ? AND remote_service_id = ?');
    const ins = db.prepare(`
      INSERT INTO product_matches (supplier_id, remote_service_id, product_id, score, status)
      VALUES (?, ?, ?, ?, 'pending')
      ON CONFLICT (supplier_id, remote_service_id) DO UPDATE SET
        product_id = excluded.product_id,
        score = excluded.score,
        updated_at = CURRENT_TIMESTAMP
      WHERE product_matches.status IN ('pending','auto')
    `);

    let updated = 0;
    for (const c of catalogs) {
      let best = null;
      let bestScore = 0;
      for (const p of products) {
        const s = scoreMatch(c.name, productNameEn(p));
        if (s > bestScore) {
          bestScore = s;
          best = p;
        }
      }
      if (!best || bestScore < 0.55) continue; // no plausible owner
      const existing = getMatch.get(c.supplier_id, c.remote_service_id);
      if (existing && existing.status === 'approved' && existing.product_id === best.id) continue;
      if (existing && existing.status === 'rejected') continue; // admin said no
      ins.run(c.supplier_id, c.remote_service_id, best.id, bestScore);
      updated++;
    }
    const pending = db.prepare("SELECT COUNT(*) c FROM product_matches WHERE status = 'pending'").get().c;
    return { pending, updated };
  }

  /** Admin decision: approve -> create the product_suppliers link. */
  static approve(matchId, adminId) {
    const m = db.prepare('SELECT * FROM product_matches WHERE id = ?').get(matchId);
    if (!m) throw new Error('match not found');
    const existsLink = db
      .prepare('SELECT 1 FROM product_suppliers WHERE supplier_id = ? AND remote_service_id = ?')
      .get(m.supplier_id, m.remote_service_id);
    if (!existsLink) {
      const prio = db
        .prepare('SELECT COALESCE(MAX(priority),0)+1 p FROM product_suppliers WHERE product_id = ?')
        .get(m.product_id).p;
      db.prepare(
        'INSERT INTO product_suppliers (product_id, supplier_id, remote_service_id, priority) VALUES (?,?,?,?)'
      ).run(m.product_id, m.supplier_id, m.remote_service_id, prio);
    }
    db.prepare("UPDATE product_matches SET status='approved', decided_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(adminId, matchId);
    return true;
  }

  static reject(matchId, adminId) {
    db.prepare("UPDATE product_matches SET status='rejected', decided_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(adminId, matchId);
  }

  /** Re-link a match to a different product before approving. */
  static reassign(matchId, productId) {
    db.prepare("UPDATE product_matches SET product_id=?, status='pending', score=1 WHERE id=?").run(productId, matchId);
  }

  /** When a new remote service appears with no plausible local product,
   *  suggest creating one (name goes through the translation queue). */
  static orphanServices(threshold = 0.55) {
    const rows = db
      .prepare(
        `SELECT sc.supplier_id, s.name AS supplier_name, sc.remote_service_id, sc.name, sc.stock, sc.price_usd
         FROM supplier_catalogs sc
         JOIN suppliers s ON s.id = sc.supplier_id
         LEFT JOIN product_matches pm ON pm.supplier_id = sc.supplier_id AND pm.remote_service_id = sc.remote_service_id
         WHERE s.enabled = 1 AND pm.id IS NULL AND COALESCE(sc.stock, 0) > 0`
      )
      .all();
    const products = db.prepare('SELECT * FROM products WHERE is_active = 1').all();
    const orphans = [];
    for (const r of rows) {
      let best = 0;
      for (const p of products) best = Math.max(best, scoreMatch(r.name, productNameEn(p)));
      if (best < threshold) orphans.push({ ...r, bestScore: best });
    }
    return orphans;
  }

  /** content_hash of the newest catalog seen; used to detect changed text. */
  static textHash(name, desc) {
    return hashText(`${name}||${desc}`);
  }
}

module.exports = CatalogMatcher;
module.exports.scoreMatch = scoreMatch;
module.exports.normalize = normalize;
