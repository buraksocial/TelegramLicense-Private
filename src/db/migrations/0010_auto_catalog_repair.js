/** Seed usable storefront categories and mark old auto-imports for repair. */
module.exports = {
  label: 'seed storefront categories and repair queue',
  up(db, { addColumn }) {
    addColumn(db, 'products', 'auto_copy_done', 'INTEGER DEFAULT 0');

    const categories = [
      ['ai', { en: 'AI & Yapay Zeka', tr: 'AI & Yapay Zeka' }, '🤖', 10],
      ['streaming', { en: 'Streaming', tr: 'Dijital Platformlar' }, '🎬', 20],
      ['software', { en: 'Software', tr: 'Yazılım' }, '💻', 30],
      ['vpn', { en: 'VPN & Güvenlik', tr: 'VPN & Güvenlik' }, '🛡️', 40],
      ['games', { en: 'Games', tr: 'Oyunlar' }, '🎮', 50],
      ['accounts', { en: 'Accounts', tr: 'Hesaplar' }, '👤', 60],
      ['other', { en: 'Other', tr: 'Diğer' }, '📦', 999]
    ];
    const insert = db.prepare(`INSERT OR IGNORE INTO categories (slug,name_json,emoji,sort_order,is_active)
      VALUES (?,?,?,?,1)`);
    for (const c of categories) insert.run(c[0], JSON.stringify(c[1]), c[2], c[3]);

    const rows = db.prepare(`SELECT p.id, p.name, p.description
      FROM products p WHERE p.is_active=1`).all();
    const getCat = db.prepare('SELECT id FROM categories WHERE slug=?');
    const add = db.prepare('INSERT OR IGNORE INTO product_categories (product_id,category_id) VALUES (?,?)');
    const tx = db.transaction(() => {
      for (const p of rows) {
        const text = `${p.name || ''} ${p.description || ''}`.toLowerCase();
        let slug = 'other';
        if (/gemini|chatgpt|claude|ai\b| yapay zek/.test(text)) slug = 'ai';
        else if (/netflix|spotify|disney|youtube|prime video|canva/.test(text)) slug = 'streaming';
        else if (/vpn|proxy|nord|surfshark|expressvpn/.test(text)) slug = 'vpn';
        else if (/windows|office|adobe|autocad|software|yazılım/.test(text)) slug = 'software';
        else if (/game|steam| oyun|xbox|playstation/.test(text)) slug = 'games';
        else if (/account|hesap|üyelik|üyelik/.test(text)) slug = 'accounts';
        add.run(p.id, getCat.get(slug).id);
      }
    });
    tx();
  }
};
