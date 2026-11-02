/** Assign the fallback/category rule to products created after migration 0010. */
module.exports = {
  label: 'backfill missing product categories',
  up(db) {
    const other = db.prepare("SELECT id FROM categories WHERE slug='other'").get();
    if (!other) return;
    const rows = db.prepare(`SELECT p.id, p.name, p.description FROM products p
      WHERE p.is_active=1 AND NOT EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id=p.id)`).all();
    const cats = {
      ai: db.prepare("SELECT id FROM categories WHERE slug='ai'").get()?.id,
      streaming: db.prepare("SELECT id FROM categories WHERE slug='streaming'").get()?.id,
      software: db.prepare("SELECT id FROM categories WHERE slug='software'").get()?.id,
      vpn: db.prepare("SELECT id FROM categories WHERE slug='vpn'").get()?.id,
      games: db.prepare("SELECT id FROM categories WHERE slug='games'").get()?.id,
      accounts: db.prepare("SELECT id FROM categories WHERE slug='accounts'").get()?.id
    };
    const add = db.prepare('INSERT OR IGNORE INTO product_categories (product_id,category_id) VALUES (?,?)');
    for (const p of rows) {
      const text = `${p.name || ''} ${p.description || ''}`.toLowerCase();
      let id = cats.ai && /gemini|chatgpt|claude|\bai\b|yapay zek/.test(text) ? cats.ai : null;
      if (!id && cats.streaming && /netflix|spotify|disney|youtube|prime video|canva/.test(text)) id = cats.streaming;
      if (!id && cats.vpn && /vpn|proxy|nord|surfshark|expressvpn/.test(text)) id = cats.vpn;
      if (!id && cats.software && /windows|office|adobe|autocad|software|yazılım/.test(text)) id = cats.software;
      if (!id && cats.games && /game|steam| oyun|xbox|playstation/.test(text)) id = cats.games;
      if (!id && cats.accounts && /account|hesap|üyelik/.test(text)) id = cats.accounts;
      add.run(p.id, id || other.id);
    }
  }
};
