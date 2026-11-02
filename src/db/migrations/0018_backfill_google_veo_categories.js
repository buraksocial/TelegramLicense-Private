/** Google Veo is a Gemini family service; move legacy direct-AI rows below it. */
module.exports = {
  label: 'backfill Gemini Veo categories',
  up(db) {
    const cat = (slug) => db.prepare('SELECT id FROM categories WHERE slug=?').get(slug)?.id;
    const ai = cat('ai');
    const products = db.prepare(`SELECT id,name,description FROM products
      WHERE is_active=1 AND (lower(name) LIKE '%gemini%' OR lower(name) LIKE '%veo%')`).all();
    const add = db.prepare('INSERT OR IGNORE INTO product_categories (product_id,category_id) VALUES (?,?)');
    const remove = db.prepare('DELETE FROM product_categories WHERE product_id=? AND category_id IN (?,?) AND category_id != ?');
    for (const p of products) {
      let raw = `${p.name || ''} ${p.description || ''}`;
      try { const n = JSON.parse(p.name); raw += ` ${n.en || ''} ${n.tr || ''}`; } catch (e) {}
      const text = raw.toLowerCase();
      const tier = (text.match(/\b(pro|plus|ultra|basic|premium|team|business|student|enterprise)\b/) || [])[1];
      const target = cat(`ai-gemini${tier ? `-${tier}` : ''}`) || cat('ai-gemini') || ai;
      if (target) add.run(p.id, target);
      if (ai && target !== ai) remove.run(p.id, ai, cat('ai-gemini') || -1, target);
    }
  }
};
