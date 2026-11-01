/**
 * 0006 — Warranty class + web store tokens.
 *
 * "Garanti" here is the supplier-side replacement window (e.g. "5H Warranty",
 * "2 Hour Warranty", "Instant Use"). Operators sell guaranteed and instant
 * variants of the SAME service as SEPARATE products with different margins.
 * Rules added to the pricing engine (see PricingEngine.decide):
 *   - a guaranteed product may ONLY be fulfilled by guaranteed services
 *     (never hand a $4 guaranteed order the $2 instant stock),
 *   - an instant product excludes guaranteed services from pricing entirely
 *     (unless the admin marks a link as mixed/unknown).
 *
 * Additive + idempotent: existing rows get warranty='unknown' and behave
 * exactly as before (no filtering for unknown).
 */
module.exports = {
  label: 'warranty classes & web tokens',
  up(db) {
    const has = (table, col) =>
      db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

    if (!has('supplier_catalogs', 'warranty')) {
      db.prepare("ALTER TABLE supplier_catalogs ADD COLUMN warranty TEXT DEFAULT 'unknown'").run();
    }
    if (!has('product_suppliers', 'warranty')) {
      db.prepare("ALTER TABLE product_suppliers ADD COLUMN warranty TEXT DEFAULT 'auto'").run();
    }
    if (!has('products', 'warranty')) {
      db.prepare("ALTER TABLE products ADD COLUMN warranty TEXT DEFAULT 'none'").run();
    }

    // Backfill: classify existing snapshot rows by name heuristics.
    db.prepare(`
      UPDATE supplier_catalogs SET warranty = 'guaranteed'
      WHERE warranty = 'unknown' AND lower(coalesce(name,'')) GLOB '*warrant*'
    `).run();
    db.prepare(`
      UPDATE supplier_catalogs SET warranty = 'guaranteed'
      WHERE warranty = 'unknown'
        AND (lower(coalesce(name,'')) LIKE '%hour%' OR lower(coalesce(name,'')) LIKE '%h warranty%'
             OR lower(coalesce(name,'')) LIKE '%garanti%')
    `).run();
    db.prepare(`
      UPDATE supplier_catalogs SET warranty = 'instant'
      WHERE warranty = 'unknown'
        AND (lower(coalesce(name,'')) LIKE '%instant%' OR lower(coalesce(name,'')) LIKE '%anl%k%'
             OR lower(coalesce(name,'')) LIKE '%no warranty%' OR lower(coalesce(name,'')) LIKE '%warranty yok%')
    `).run();

    // Existing local products: names containing warranty words are guaranteed,
    // everything else stays 'none' (= today's behaviour: no filtering).
    db.prepare(`
      UPDATE products SET warranty = 'guaranteed'
      WHERE warranty = 'none'
        AND (lower(name) LIKE '%warrant%' OR lower(name) LIKE '%garant%')
    `).run();

    db.exec(`
      CREATE TABLE IF NOT EXISTS web_tokens (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_web_tokens_user ON web_tokens (user_id);
      CREATE INDEX IF NOT EXISTS idx_web_tokens_expiry ON web_tokens (expires_at);
    `);
  }
};
