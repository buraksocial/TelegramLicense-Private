/** Merge duplicate storefront rows created by older catalog imports. */
module.exports = {
  label: 'merge duplicate catalog products',
  up(db) {
    const rows = db.prepare('SELECT id,name FROM products WHERE is_active=1 ORDER BY id').all();
    const keyOf = (value) => {
      let text = String(value || '');
      try { const j = JSON.parse(text); text = j.en || j.tr || text; } catch (e) {}
      return text.toLowerCase().replace(/\b(30\s*days?|1\s*month)\b/g, '1 month')
        .replace(/[^a-z0-9çğıöşüı]+/g, ' ').trim().replace(/\s+/g, ' ');
    };
    const seen = new Map();
    const merge = db.transaction((keep, drop) => {
      db.prepare('UPDATE orders SET product_id=? WHERE product_id=?').run(keep, drop);
      db.prepare('UPDATE reservations SET product_id=? WHERE product_id=?').run(keep, drop);
      db.prepare('UPDATE product_matches SET product_id=? WHERE product_id=?').run(keep, drop);
      for (const c of db.prepare('SELECT category_id FROM product_categories WHERE product_id=?').all(drop)) {
        db.prepare('INSERT OR IGNORE INTO product_categories (product_id,category_id) VALUES (?,?)').run(keep, c.category_id);
      }
      for (const link of db.prepare('SELECT * FROM product_suppliers WHERE product_id=?').all(drop)) {
        const exists = db.prepare('SELECT id FROM product_suppliers WHERE product_id=? AND supplier_id=? AND remote_service_id=?')
          .get(keep, link.supplier_id, link.remote_service_id);
        if (exists) db.prepare('DELETE FROM product_suppliers WHERE id=?').run(link.id);
        else db.prepare('UPDATE product_suppliers SET product_id=? WHERE id=?').run(keep, link.id);
      }
      db.prepare('UPDATE products SET is_active=0 WHERE id=?').run(drop);
    });
    for (const p of rows) {
      const key = keyOf(p.name);
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, p.id);
      else merge(seen.get(key), p.id);
    }
  }
};
