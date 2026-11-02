/** Auto-imported products use the cheapest in-stock supplier as price anchor. */
module.exports = {
  label: 'use cheapest pricing for auto-imported products',
  up(db) {
    db.prepare(`UPDATE products SET pricing_mode='cheapest'
      WHERE id IN (SELECT DISTINCT product_id FROM product_suppliers WHERE note='auto-import')`).run();
  }
};
