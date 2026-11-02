/** Automatic catalog import and unpaid reservation metadata. */
module.exports = {
  label: 'automatic catalog import and reservation payments',
  up(db, { addColumn }) {
    addColumn(db, 'categories', 'default_margin_percent', 'REAL');
    addColumn(db, 'categories', 'default_floor_price', 'REAL');
    addColumn(db, 'reservations', 'paid_usd', 'REAL DEFAULT 0');
    addColumn(db, 'reservations', 'support_note', 'TEXT');

    db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_import_margin_percent', '150')`).run();
    db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_import_floor_price', '2')`).run();
    db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('reservation_support_username', '@MerhabaWorld')`).run();
  }
};
