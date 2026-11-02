/** Add the second level: AI brand -> plan tier (Pro, Plus, ...). */
module.exports = {
  label: 'create AI tier subcategories',
  up(db) {
    const brands = db.prepare("SELECT id,slug FROM categories WHERE slug IN ('ai-gemini','ai-chatgpt','ai-deepseek','ai-claude')").all();
    const tiers = [
      ['pro', 'Pro', 'Pro', 1], ['plus', 'Plus', 'Plus', 2],
      ['ultra', 'Ultra', 'Ultra', 3], ['basic', 'Basic', 'Basic', 4],
      ['premium', 'Premium', 'Premium', 5]
    ];
    const ins = db.prepare(`INSERT OR IGNORE INTO categories
      (parent_id,slug,name_json,emoji,sort_order,is_active) VALUES (?,?,?,?,?,1)`);
    for (const b of brands) for (const t of tiers) {
      ins.run(b.id, `${b.slug}-${t[0]}`, JSON.stringify({ en: t[1], tr: t[2] }), '📦', b.slug === 'ai-gemini' ? 100 + t[3] : 200 + t[3]);
    }

    const products = db.prepare('SELECT id,name,description FROM products WHERE is_active=1').all();
    const add = db.prepare('INSERT OR IGNORE INTO product_categories (product_id,category_id) VALUES (?,?)');
    const remove = db.prepare('DELETE FROM product_categories WHERE product_id=? AND category_id IN (SELECT id FROM categories WHERE slug=?)');
    for (const p of products) {
      const text = `${p.name || ''} ${p.description || ''}`.toLowerCase();
      const brand = ['gemini','chatgpt','deepseek','claude'].find((b) => text.includes(b));
      const tier = ['pro','plus','ultra','basic','premium'].find((t) => new RegExp(`\\b${t}\\b`).test(text));
      if (!brand || !tier) continue;
      const cat = db.prepare('SELECT id FROM categories WHERE slug=?').get(`ai-${brand}-${tier}`);
      if (!cat) continue;
      add.run(p.id, cat.id);
      remove.run(p.id, `ai-${brand}`);
      remove.run(p.id, 'ai');
    }
  }
};
