/**
 * 0002 — Translation / i18n schema (additive).
 *
 * Languages become data instead of a hard-coded i18n.js object, so the admin
 * can add a language at runtime and the agent backfills product text.
 */
const { CORE_LANGS } = require('../../constants');

module.exports = {
  label: 'translation & i18n schema',
  up(db, { addColumn }) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS languages (
        code TEXT PRIMARY KEY,
        name TEXT,
        native_name TEXT,
        flag TEXT,
        enabled INTEGER DEFAULT 1,
        rtl INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS translations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_text TEXT NOT NULL,
        source_lang TEXT DEFAULT 'en',
        target_lang TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        translated_text TEXT,
        provider TEXT,
        model TEXT,
        status TEXT DEFAULT 'pending', -- pending | done | failed | skipped
        attempts INTEGER DEFAULT 0,
        last_error TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (content_hash, target_lang)
      );
      CREATE INDEX IF NOT EXISTS idx_translations_status ON translations (status, target_lang);

      CREATE TABLE IF NOT EXISTS i18n_overrides (
        lang TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (lang, key)
      );

      CREATE TABLE IF NOT EXISTS translation_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL, -- product_name | product_desc | category
        entity_id INTEGER NOT NULL,
        field TEXT NOT NULL,
        source_text TEXT,
        content_hash TEXT,
        reason TEXT, -- new | name_change | desc_change | lang_added | manual
        status TEXT DEFAULT 'pending', -- pending | done | failed
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (entity_type, entity_id, field, content_hash)
      );
    `);

    // Seed core languages once (INSERT OR IGNORE keeps re-runs and admin edits safe).
    const ins = db.prepare(
      'INSERT OR IGNORE INTO languages (code, native_name, flag, enabled, sort_order) VALUES (?, ?, ?, 1, ?)'
    );
    CORE_LANGS.forEach((l, i) => ins.run(l.code, l.native, l.flag, i));
  }
};
