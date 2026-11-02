/** Normalize products imported before the auto-import marker was introduced. */
module.exports = {
  label: 'repair legacy auto-import products',
  up(db) {
    // Before 0010, the importer did not write note='auto-import'. These rows
    // are still identifiable by the importer marker column's default (0) and
    // their supplier link. Do not touch ordinary products without a link.
    db.prepare(`UPDATE product_suppliers SET note='auto-import'
      WHERE note IS NULL AND product_id IN (
        SELECT p.id FROM products p WHERE COALESCE(p.auto_copy_done,0)=0
      )`).run();
    db.prepare(`UPDATE products SET pricing_mode='cheapest'
      WHERE COALESCE(auto_copy_done,0)=0
        AND id IN (SELECT DISTINCT product_id FROM product_suppliers WHERE note='auto-import')`).run();
  }
};
