/** Per-user favorite supplier offers. */
module.exports = {
  label: 'add user favorite services',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS user_favorite_services (
      user_id INTEGER NOT NULL,
      product_supplier_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, product_supplier_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (product_supplier_id) REFERENCES product_suppliers(id) ON DELETE CASCADE
    );`);
  }
};
