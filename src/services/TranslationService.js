/**
 * TranslationService — LLM-powered translation agent.
 *
 * Responsibilities (the "act like an agent" requirement):
 *  1. Watch supplier catalog snapshots: whenever a NEW remote service appears
 *     or a name/description changes (content_hash differs), queue it for
 *     translation into EVERY enabled language (translations table, UNIQUE on
 *     content_hash+target_lang so the same text is never paid for twice).
 *  2. Also queue local product name/description changes.
 *  3. Process the queue in batches through the OpenAI-compatible LLM
 *     (api.developer.org.tr / gpt-6.1-sol), 25 segments per call to keep
 *     prompt overhead cheap.
 *  4. When the admin adds a new language, backfill: every known source text
 *     is queued for that language, and UI strings are translated into
 *     i18n_overrides so the whole bot speaks it.
 *
 * The tick loop is quiet: it only spends tokens when there is pending work.
 */
const crypto = require('crypto');
const axios = require('axios');
const { db } = require('../db');
const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = require('../config/env');

const BATCH_SIZE = parseInt(process.env.LLM_BATCH_SIZE || '25', 10);
const TICK_MS = parseInt(process.env.TRANSLATE_TICK_MS || '60000', 10);
const MAX_BATCHES_PER_TICK = 3;

function hashText(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 16);
}

function enabledLangs() {
  return db.prepare('SELECT code FROM languages WHERE enabled = 1 ORDER BY sort_order').all().map((r) => r.code);
}

const LANG_NAMES = {
  en: 'English', tr: 'Turkish', ru: 'Russian', zh: 'Chinese (Simplified)',
  hi: 'Hindi', de: 'German', fr: 'French', es: 'Spanish', ar: 'Arabic',
  az: 'Azerbaijani', it: 'Italian', pt: 'Portuguese', uk: 'Ukrainian', ja: 'Japanese'
};

function langName(code) {
  const row = db.prepare('SELECT native_name, name FROM languages WHERE code = ?').get(code);
  return row?.name || row?.native_name || LANG_NAMES[code] || code;
}

async function llmTranslate(texts, targetLang) {
  const messages = [
    {
      role: 'system',
      content:
        'You translate product titles and short descriptions for a Telegram digital-license store. ' +
        'Input is JSON: {"items":["text1","text2",...]}. ' +
        `Output JSON: {"items":["translated1","translated2",...]} in ${langName(targetLang)}, same length and order. ` +
        'Keep brand names (Gemini, Spotify, Adobe, ChatGPT...), emojis, prices, URLs unchanged. No markdown.'
    },
    { role: 'user', content: JSON.stringify({ items: texts }) }
  ];

  const res = await axios.post(
    `${LLM_BASE_URL}/chat/completions`,
    { model: LLM_MODEL, messages, temperature: 0.2, response_format: { type: 'json_object' } },
    {
      headers: { Authorization: `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 90000
    }
  );

  const content = res.data?.choices?.[0]?.message?.content || '';
  let out;
  try {
    const parsed = JSON.parse(content);
    out = Array.isArray(parsed) ? parsed : parsed.items || parsed.translations || parsed.result || null;
  } catch (e) {
    const m = content.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('LLM returned no JSON array');
    out = JSON.parse(m[0]);
  }
  if (!Array.isArray(out) || out.length !== texts.length) {
    throw new Error(`LLM length mismatch (${out?.length} vs ${texts.length})`);
  }
  return out.map((s) => String(s).trim());
}

const upsertTranslation = db.prepare(`
  INSERT INTO translations (source_text, source_lang, target_lang, content_hash, translated_text, provider, model, status, updated_at)
  VALUES (?, 'en', ?, ?, ?, 'openai-compat', ?, 'done', CURRENT_TIMESTAMP)
  ON CONFLICT (content_hash, target_lang) DO UPDATE SET
    translated_text = excluded.translated_text,
    status = 'done',
    last_error = NULL,
    updated_at = CURRENT_TIMESTAMP
`);

const markFailed = db.prepare(`
  INSERT INTO translations (source_text, target_lang, content_hash, status, attempts, last_error, updated_at)
  VALUES (?, ?, ?, 'failed', 1, ?, CURRENT_TIMESTAMP)
  ON CONFLICT (content_hash, target_lang) DO UPDATE SET
    attempts = attempts + 1,
    last_error = excluded.last_error,
    status = 'failed'
`);

class TranslationService {
  constructor() {
    this.timer = null;
    this.bot = null;
    this.busy = false;
  }

  /** Read a translated string for display; falls back to the source text. */
  static translate(sourceText, lang, { field = 'name' } = {}) {
    if (!sourceText || lang === 'en') return sourceText;
    const h = hashText(sourceText);
    const row = db
      .prepare("SELECT translated_text FROM translations WHERE content_hash = ? AND target_lang = ? AND status = 'done'")
      .get(h, lang);
    return (row && row.translated_text) || sourceText;
  }

  /** Queue a source text for all enabled languages (dedup by hash). */
  static enqueue(entityType, entityId, field, sourceText, reason = 'new') {
    if (!sourceText) return 0;
    const h = hashText(sourceText);
    const langs = enabledLangs().filter((l) => l !== 'en');
    const ins = db.prepare(`
      INSERT OR IGNORE INTO translation_queue (entity_type, entity_id, field, source_text, content_hash, reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const exists = db.prepare(
      'SELECT 1 FROM translations WHERE content_hash = ? AND target_lang = ? AND status IN (\'done\',\'pending\')'
    );
    let added = 0;
    for (const lang of langs) {
      if (exists.get(h, lang)) continue; // already done or in flight
      const r = ins.run(entityType, entityId, `${field}:${lang}`, sourceText, h, reason);
      added += r.changes;
    }
    return added;
  }

  /** Scan catalogs + products for new/changed texts and enqueue them. */
  static async discover() {
    // 1. Remote catalog services (supplier_catalogs) — name + description.
    //    Linked (menu-visible) services are enqueued first so their ids are
    //    lowest and processQueue (ORDER BY id) translates them before orphans.
    const catalogs = db
      .prepare(
        `SELECT sc.supplier_id, sc.remote_service_id, sc.name, sc.description, sc.content_hash,
           (SELECT COUNT(*) FROM product_suppliers ps
             WHERE ps.supplier_id = sc.supplier_id AND ps.remote_service_id = sc.remote_service_id) AS linked
         FROM supplier_catalogs sc JOIN suppliers s ON s.id = sc.supplier_id
         WHERE s.enabled = 1
         ORDER BY linked DESC, sc.supplier_id, sc.remote_service_id`
      )
      .all();
    for (const c of catalogs) {
      const h = hashText(`${c.name}||${c.description}`);
      const known = db
        .prepare('SELECT 1 FROM translations WHERE content_hash IN (?, ?) AND target_lang != \'en\' LIMIT 1')
        .get(hashText(c.name), hashText(c.description));
      if (!known) {
        TranslationService.enqueue('catalog', c.supplier_id, 'name', c.name, 'new');
        if (c.description) TranslationService.enqueue('catalog', c.supplier_id, 'desc', c.description, 'new');
      }
      void h;
    }

    // 2. Local products (name JSON changes)
    const products = db.prepare('SELECT id, name FROM products').all();
    const en = (() => {
      const out = [];
      for (const p of products) {
        let parsed = null;
        try { parsed = JSON.parse(p.name); } catch (e) {}
        const enName = parsed ? parsed.en : p.name;
        if (!enName) continue;
        const h = hashText(enName);
        const done = db
          .prepare('SELECT 1 FROM translations WHERE content_hash = ? AND status = \'done\' LIMIT 1')
          .get(h);
        if (!done && !parsed) TranslationService.enqueue('product', p.id, 'name', enName, 'name_change');
        out.push({ id: p.id, enName, parsed });
      }
      return out;
    })();

    // 3. Products missing translations for an enabled language -> queue + mark
    const langs = enabledLangs().filter((l) => l !== 'en');
    for (const { id, enName, parsed } of en) {
      for (const lang of langs) {
        if (parsed && parsed[lang]) continue; // already has localized text
        TranslationService.enqueue('product', id, 'name', enName, 'new');
      }
    }
  }

  /** Process up to N batches of pending queue rows. */
  static async processQueue() {
    const queueRows = db
      .prepare(
        "SELECT * FROM translation_queue WHERE status = 'pending' ORDER BY id LIMIT ?"
      )
      .all(BATCH_SIZE * MAX_BATCHES_PER_TICK);
    if (!queueRows.length) return 0;

    // group by target lang (field stored as "name:tr")
    const byLang = new Map();
    for (const q of queueRows) {
      const lang = q.field.split(':')[1] || q.field;
      if (!byLang.has(lang)) byLang.set(lang, []);
      byLang.get(lang).push(q);
    }

    let done = 0;
    const doneStmt = db.prepare("UPDATE translation_queue SET status = 'done' WHERE id = ?");
    const failStmt = db.prepare("UPDATE translation_queue SET status = 'failed' WHERE id = ?");

    for (const [lang, rows] of byLang) {
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const chunk = rows.slice(i, i + BATCH_SIZE);
        // dedupe identical source texts inside the chunk
        const uniq = [...new Map(chunk.map((r) => [r.content_hash + lang, r])).values()];
        try {
          const out = await llmTranslate(uniq.map((r) => r.source_text), lang);
          db.transaction(() => {
            uniq.forEach((r, idx) => {
              upsertTranslation.run(r.source_text, lang, r.content_hash, out[idx], LLM_MODEL);
              doneStmt.run(r.id);
              done++;
            });
          })();
        } catch (err) {
          console.error(`[TranslationService] ${lang} batch failed:`, err.message);
          for (const r of uniq) {
            markFailed.run(r.source_text, lang, r.content_hash, String(err.message).slice(0, 200));
            if ((r.attempts || 0) + 1 >= 3) failStmt.run(r.id);
          }
        }
        await new Promise((res) => setTimeout(res, 400));
      }
    }
    return done;
  }

  /** Push translated names back into products.name JSON when missing. */
  static applyToProducts() {
    const products = db.prepare('SELECT id, name FROM products').all();
    const upd = db.prepare('UPDATE products SET name = ? WHERE id = ?');
    for (const p of products) {
      let parsed;
      try { parsed = JSON.parse(p.name); } catch (e) { continue; }
      const enName = parsed.en;
      if (!enName) continue;
      let changed = false;
      for (const lang of enabledLangs()) {
        if (lang === 'en' || parsed[lang]) continue;
        const tr = TranslationService.translate(enName, lang);
        if (tr && tr !== enName) {
          parsed[lang] = tr;
          changed = true;
        }
      }
      if (changed) upd.run(JSON.stringify(parsed), p.id);
    }
  }

  /** Backfill everything for a newly added language (UI strings included). */
  static async backfillLanguage(lang) {
    const texts = new Set();
    for (const c of db.prepare('SELECT name, description FROM supplier_catalogs').all()) {
      if (c.name) texts.add(c.name);
      if (c.description && c.description.length < 300) texts.add(c.description);
    }
    for (const p of db.prepare('SELECT name FROM products').all()) {
      try { const j = JSON.parse(p.name); if (j.en) texts.add(j.en); } catch (e) { texts.add(p.name); }
    }
    for (const t of [...texts]) TranslationService.enqueue('backfill', 0, `name:${lang}`, t, 'lang_added');

    // UI strings: translate the English catalog into overrides
    try {
      const { locales } = require('../utils/i18n');
      const keys = Object.keys(locales.en || {});
      const chunk = [];
      const meta = [];
      for (const k of keys) {
        chunk.push(locales.en[k]);
        meta.push(k);
        if (chunk.length >= BATCH_SIZE) {
          await this.flushUiChunk(lang, chunk, meta);
          chunk.length = 0; meta.length = 0;
        }
      }
      if (chunk.length) await this.flushUiChunk(lang, chunk, meta);
    } catch (e) {
      console.error('[TranslationService] UI backfill failed:', e.message);
    }
    await TranslationService.processQueue();
  }

  static async flushUiChunk(lang, texts, keys) {
    try {
      const out = await llmTranslate(texts, lang);
      const ins = db.prepare(`
        INSERT INTO i18n_overrides (lang, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT (lang, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `);
      db.transaction(() => { keys.forEach((k, i) => ins.run(lang, k, out[i])); })();
    } catch (e) {
      console.error(`[TranslationService] ui chunk failed (${lang}):`, e.message);
    }
  }

  start(bot, tickMs = TICK_MS) {
    this.bot = bot;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), tickMs);
    setTimeout(() => this.tick(), 30000);
    console.log(`[TranslationService] agent started (tick ${tickMs / 1000}s, model ${LLM_MODEL})`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await TranslationService.discover();
      const n = await TranslationService.processQueue();
      if (n) {
        TranslationService.applyToProducts();
        const pending = db.prepare("SELECT COUNT(*) c FROM translation_queue WHERE status='pending'").get().c;
        if (pending === 0 && this.bot) {
          console.log(`[TranslationService] queue drained (+${n} translations)`);
        }
      }
    } catch (err) {
      console.error('[TranslationService] tick error:', err.message);
    } finally {
      this.busy = false;
    }
  }
}

const svc = new TranslationService();
module.exports = Object.assign(svc, {
  TranslationService,
  hashText,
  enabledLangs
});
module.exports.TranslationService = TranslationService;
