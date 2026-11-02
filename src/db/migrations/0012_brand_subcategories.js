/** Create brand subcategories under the top-level AI category. */
module.exports = {
  label: 'create brand subcategories',
  up(db) {
    const ai = db.prepare("SELECT id FROM categories WHERE slug='ai'").get();
    if (!ai) return;
    const brands = [
      ['ai-gemini', { en: 'Gemini', tr: 'Gemini' }, '✨', 11, /gemini/],
      ['ai-chatgpt', { en: 'ChatGPT', tr: 'ChatGPT' }, '🧠', 12, /chatgpt|gpt\b/],
      ['ai-deepseek', { en: 'DeepSeek', tr: 'DeepSeek' }, '🔎', 13, /deepseek/],
      ['ai-claude', { en: 'Claude', tr: 'Claude' }, '🟠', 14, /claude/],
      ['ai-other', { en: 'Other AI', tr: 'Diğer AI' }, '🤖', 19, null]
    ];
    const ins = db.prepare(`INSERT OR IGNORE INTO categories
      (parent_id,slug,name_json,emoji,sort_order,is_active) VALUES (?,?,?,?,?,1)`);
    for (const b of brands) ins.run(ai.id, b[0], JSON.stringify(b[1]), b[2], b[3]);

    const cats = new Map(db.prepare("SELECT id,slug FROM categories WHERE parent_id=?").all(ai.id).map((r) => [r.slug, r.id]));
    const products = db.prepare(`SELECT p.id,p.name,p.description FROM products p
      WHERE p.is_active=1`).all();
    const delTop = db.prepare('DELETE FROM product_categories WHERE product_id=? AND category_id=?');
    const add = db.prepare('INSERT OR IGNORE INTO product_categories (product_id,category_id) VALUES (?,?)');
    for (const p of products) {
      const text = `${p.name || ''} ${p.description || ''}`.toLowerCase();
      const brand = brands.find((b) => b[4] && b[4].test(text));
      if (!brand) continue;
      add.run(p.id, cats.get(brand[0]));
      delTop.run(p.id, ai.id);
    }
  }
};
