/**
 * admin_suppliers2 — Faz 5/8 admin ekranları:
 *   📚 canlı katalog gezgini, 🔗 eşleşme onay kuyruğu, 🗂 kategori yönetimi,
 *   🌐 dil yönetimi (yeni dil = LLM backfill) ve 🚨 watchdog uyarıları.
 * admin.js üzerinden kurulur; admin_api menüsünden erişilir.
 */
const { db } = require('../db');
const CatalogMatcher = require('../services/CatalogMatcher');

function setupAdminSuppliers2(bot, adminMiddleware) {
  const back = (target) => ({ inline_keyboard: [[{ text: '🔙 Geri', callback_data: target }]] });

  // ---------------- Catalog browser ----------------------------------------
  bot.action(/^admin2_catalog_(\d+)(?:_(\d+))?$/, adminMiddleware, (ctx) => {
    const supId = parseInt(ctx.match[1], 10);
    const page = parseInt(ctx.match[2] || '1', 10);
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supId);
    if (!supplier) return ctx.answerCbQuery('Tedarikçi yok.', { show_alert: true });

    const limit = 15;
    const total = db.prepare('SELECT COUNT(*) c FROM supplier_catalogs WHERE supplier_id = ?').get(supId).c;
    const rows = db
      .prepare('SELECT * FROM supplier_catalogs WHERE supplier_id = ? ORDER BY price_usd IS NULL, price_usd, name LIMIT ? OFFSET ?')
      .all(supId, limit, (page - 1) * limit);
    const linked = db
      .prepare('SELECT remote_service_id FROM product_suppliers WHERE supplier_id = ?')
      .all(supId).map((r) => r.remote_service_id);

    let text = `📚 <b>${supplier.name}</b> — ${total} servis · ${linked.length} bağlı\nSayfa ${page}/${Math.max(1, Math.ceil(total / limit))}\n\n`;
    for (const r of rows) {
      const mark = linked.includes(r.remote_service_id) ? '🔗' : '▫️';
      text += `${mark} <b>$${r.price_usd ?? '?'}</b> · stok ${r.stock ?? '?'} · ${(r.name || r.remote_service_id).slice(0, 42)}\n`;
    }

    const keyboard = [];
    const nav = [];
    if (page > 1) nav.push({ text: '⬅️', callback_data: `admin2_catalog_${supId}_${page - 1}` });
    if (page * limit < total) nav.push({ text: '➡️', callback_data: `admin2_catalog_${supId}_${page + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: '🧠 Eşleşme Önerisi Üret', callback_data: 'admin2_match_scan' }]);
    keyboard.push([{ text: '🔙 Geri', callback_data: 'admin_api_menu' }]);

    return ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
  });

  // ---------------- Match approval queue --------------------------------------
  function renderMatches(ctx, page = 1) {
    const limit = 8;
    const total = db.prepare("SELECT COUNT(*) c FROM product_matches WHERE status='pending'").get().c;
    const rows = db.prepare(`
      SELECT pm.*, s.name AS supplier_name, sc.name AS service_name, sc.price_usd, sc.stock, p.name AS product_name
      FROM product_matches pm
      JOIN suppliers s ON s.id = pm.supplier_id
      LEFT JOIN supplier_catalogs sc ON sc.supplier_id = pm.supplier_id AND sc.remote_service_id = pm.remote_service_id
      LEFT JOIN products p ON p.id = pm.product_id
      WHERE pm.status = 'pending'
      ORDER BY pm.score DESC LIMIT ? OFFSET ?
    `).all(limit, (page - 1) * limit);

    if (!rows.length) {
      return ctx.editMessageText('✅ Onay bekleyen eşleşme yok.', {
        reply_markup: { inline_keyboard: [[{ text: '🧠 Tara', callback_data: 'admin2_match_scan' }], [{ text: '🔙 Geri', callback_data: 'admin_api_menu' }]] } }
      ).catch(() => {});
    }

    const pages = Math.max(1, Math.ceil(total / limit));
    let text = `🔗 <b>Eşleşme Onayı</b> (sayfa ${page}/${pages}) — yüksek skordan başla:\n\n`;
    const keyboard = [];
    for (const r of rows) {
      let pname = r.product_name || '?';
      try { const j = JSON.parse(pname); pname = j.tr || j.en || pname; } catch (e) {}
      text += `<b>#${r.id}</b> skor <b>%${Math.round(r.score * 100)}</b> — ${r.supplier_name}\n` +
        `  servis: <code>${(r.service_name || r.remote_service_id).slice(0, 45)}</code> ($${r.price_usd ?? '?'} / ${r.stock ?? '?'} stok)\n` +
        `  → ürün: <b>${String(pname).slice(0, 40)}</b>\n\n`;
      keyboard.push([
        { text: '✅ Onayla', callback_data: `admin2_match_ok_${r.id}` },
        { text: '❌ Reddet', callback_data: `admin2_match_no_${r.id}` },
        { text: '🔄 Ürün değiştir', callback_data: `admin2_match_re_${r.id}` }
      ]);
    }
    const nav = [];
    if (page > 1) nav.push({ text: '⬅️', callback_data: `admin2_matches_${page - 1}` });
    if (page < pages) nav.push({ text: '➡️', callback_data: `admin2_matches_${page + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: '🔙 Geri', callback_data: 'admin_api_menu' }]);

    return ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
  }

  bot.action('admin2_match_scan', adminMiddleware, (ctx) => {
    ctx.answerCbQuery('Katalog taranıyor...').catch(() => {});
    try {
      const res = CatalogMatcher.suggest();
      const orphans = CatalogMatcher.orphanServices();
      return ctx.editMessageText(
        `🧠 <b>Tarama bitti</b>\nYeni/güncel aday: ${res.updated}\nOnay bekleyen: ${res.pending}\nSahipsiz aktif servis: ${orphans.length}\n\n` +
        (orphans.length ? 'Bunlar için admin ürün eklerse isimler otomatik çevrilir (dil ajanı).' : ''),
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔗 Kuyruğu Aç', callback_data: 'admin2_matches_1' }], back('admin_api_menu')] }
        }
      ).catch(() => {});
    } catch (e) {
      return ctx.answerCbQuery('Hata: ' + e.message, { show_alert: true });
    }
  });

  bot.action(/^admin2_matches_(\d+)$/, adminMiddleware, (ctx) => renderMatches(ctx, parseInt(ctx.match[1], 10) || 1));

  bot.action(/^admin2_match_ok_(\d+)$/, adminMiddleware, (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    try {
      CatalogMatcher.approve(id, ctx.from.id);
      ctx.answerCbQuery('Bağlantı kuruldu ✓').catch(() => {});
    } catch (e) {
      ctx.answerCbQuery('Hata: ' + e.message, { show_alert: true }).catch(() => {});
    }
    return renderMatches(ctx, 1);
  });

  bot.action(/^admin2_match_no_(\d+)$/, adminMiddleware, (ctx) => {
    CatalogMatcher.reject(parseInt(ctx.match[1], 10), ctx.from.id);
    ctx.answerCbQuery('Reddedildi').catch(() => {});
    return renderMatches(ctx, 1);
  });

  bot.action(/^admin2_match_re_(\d+)$/, adminMiddleware, (ctx) => {
    const matchId = parseInt(ctx.match[1], 10);
    const products = db.prepare('SELECT * FROM products WHERE is_active = 1').all();
    const keyboard = products.map((p) => {
      let n = p.name;
      try { const j = JSON.parse(n); n = j.tr || j.en || n; } catch (e) {}
      return [{ text: `→ ${String(n).slice(0, 40)}`, callback_data: `admin2_match_set_${matchId}_${p.id}` }];
    });
    keyboard.push([{ text: '🔙 Kuyruk', callback_data: 'admin2_matches_1' }]);
    return ctx.editMessageText('🔄 Bu servisi hangi yerel ürüne bağlayalım?', { reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
  });

  bot.action(/^admin2_match_set_(\d+)_(\d+)$/, adminMiddleware, (ctx) => {
    const matchId = parseInt(ctx.match[1], 10);
    CatalogMatcher.reassign(matchId, parseInt(ctx.match[2], 10));
    try {
      CatalogMatcher.approve(matchId, ctx.from.id);
      ctx.answerCbQuery('Taşındı ve onaylandı ✓').catch(() => {});
    } catch (e) {
      ctx.answerCbQuery('Hata: ' + e.message, { show_alert: true }).catch(() => {});
    }
    return renderMatches(ctx, 1);
  });

  // ---------------- Category management ---------------------------------------
  bot.action('admin2_categories', adminMiddleware, (ctx) => {
    const cats = db.prepare('SELECT * FROM categories ORDER BY sort_order, id').all();
    const keyboard = cats.map((c) => {
      let n = c.slug;
      try { const j = JSON.parse(c.name_json); n = j.tr || j.en || c.slug; } catch (e) {}
      const count = db.prepare('SELECT COUNT(*) c FROM product_categories WHERE category_id = ?').get(c.id).c;
      return [{ text: `${c.emoji || '📂'} ${n} (${count})`, callback_data: `admin2_cat_del_${c.id}` }];
    });
    if (!keyboard.length) keyboard.push([{ text: 'Henüz kategori yok', callback_data: 'admin2_categories' }]);
    keyboard.push([{ text: '➕ Yeni Kategori', callback_data: 'admin2_cat_add' }]);
    keyboard.push([{ text: '🔗 Ürünleri Kategorile (auto)', callback_data: 'admin2_cat_auto' }]);
    keyboard.push(back('admin_api_menu'));
    return ctx.editMessageText(
      '🗂 <b>Kategoriler</b>\nMüşteri menüsü kategori ızgarasıyla başlar; kategorisiz ürünler "Tümü" altında listelenir.\nBir kategoriye dokunursan o kategori <b>silinir</b> (ürünler bağsız kalır).',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
    ).catch(() => {});
  });

  bot.action('admin2_cat_add', adminMiddleware, (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.adminState = 'waiting_new_category';
    return ctx.editMessageText('Kategori adı yazın (başına emoji koyabilirsiniz, örn: 🤖 AI Abonelik):', {
      reply_markup: back('admin2_categories')
    }).catch(() => {});
  });

  bot.action(/^admin2_cat_del_(\d+)$/, adminMiddleware, (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    db.prepare('DELETE FROM product_categories WHERE category_id = ?').run(id);
    ctx.answerCbQuery('Kategori silindi').catch(() => {});
    return ctx.editMessageText(`🗂 Kategori #${id} ve ürün bağları silindi.`, { reply_markup: back('admin2_categories') }).catch(() => {});
  });

  bot.action('admin2_cat_auto', adminMiddleware, (ctx) => {
    let assigned = 0;
    const cats = db.prepare('SELECT * FROM categories').all();
    const products = db.prepare('SELECT * FROM products WHERE is_active = 1').all();
    const ins = db.prepare('INSERT OR IGNORE INTO product_categories (product_id, category_id) VALUES (?, ?)');
    for (const p of products) {
      const has = db.prepare('SELECT 1 FROM product_categories WHERE product_id = ? LIMIT 1').get(p.id);
      if (has) continue;
      let n = p.name;
      try { const j = JSON.parse(n); n = `${j.en || ''} ${j.tr || ''}`; } catch (e) {}
      const nl = n.toLowerCase();
      let cat = null;
      for (const c of cats) {
        const words = c.slug.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
        if (words.some((w) => nl.includes(w))) { cat = c; break; }
      }
      if (cat) { ins.run(p.id, cat.id); assigned++; }
    }
    return ctx.editMessageText(
      `🔗 Otomatik kategorileme: ${assigned} ürün bağlandı (ad eşleşmesine göre).`,
      { reply_markup: back('admin2_categories') }
    ).catch(() => {});
  });

  // ---------------- Language management ----------------------------------------
  bot.action('admin2_languages', adminMiddleware, (ctx) => {
    const langs = db.prepare('SELECT * FROM languages ORDER BY sort_order').all();
    const keyboard = langs.map((l) => [{
      text: `${l.enabled ? '🟢' : '⚪'} ${l.native_name} (${l.code})${l.enabled ? '' : ' — etkinleştir: çevir'}`,
      callback_data: `admin2_lang_toggle_${l.code}`
    }]);
    keyboard.push([{ text: '➕ Yeni Dil Ekle & Çevirt', callback_data: 'admin2_lang_add' }]);
    keyboard.push([{ text: '📊 Çeviri Durumu', callback_data: 'admin2_lang_status' }]);
    keyboard.push(back('admin_api_menu'));
    return ctx.editMessageText(
      '🌐 <b>Diller</b>\nYeni dil eklersen ajan; tüm servis adlarını, ürün isimlerini ve menü metinlerini LLM ile çevirir (arka planda, kuyrukla).',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
    ).catch(() => {});
  });

  bot.action(/^admin2_lang_toggle_(\w+)$/, adminMiddleware, (ctx) => {
    const code = ctx.match[1];
    const row = db.prepare('SELECT * FROM languages WHERE code = ?').get(code);
    if (!row) return ctx.answerCbQuery('Dil yok.', { show_alert: true });
    if (!row.enabled) {
      db.prepare('UPDATE languages SET enabled = 1 WHERE code = ?').run(code);
      ctx.answerCbQuery('Dil etkin — çeviri başlıyor').catch(() => {});
      require('../services/TranslationService').TranslationService
        .backfillLanguage(code).catch((e) => console.error('backfill failed:', e.message));
    } else {
      db.prepare('UPDATE languages SET enabled = 0 WHERE code = ?').run(code);
      ctx.answerCbQuery('Dil kapatıldı').catch(() => {});
    }
    return undefined;
  });

  bot.action('admin2_lang_add', adminMiddleware, (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.adminState = 'waiting_new_lang';
    return ctx.editMessageText('Yeni dil kodu + adını yazın (örn: <code>es İspanyolca</code>). Bot tüm içerik ve menüleri bu dile çevirtecek.', {
      parse_mode: 'HTML',
      reply_markup: back('admin2_languages')
    }).catch(() => {});
  });

  bot.action('admin2_lang_status', adminMiddleware, (ctx) => {
    const q = db.prepare('SELECT status, COUNT(*) c FROM translation_queue GROUP BY status').all();
    const tr = db.prepare("SELECT target_lang, COUNT(*) c FROM translations WHERE status='done' GROUP BY target_lang").all();
    const langs = db.prepare('SELECT code FROM languages WHERE enabled = 1').all().map((r) => r.code);
    return ctx.editMessageText(
      `📊 <b>Çeviri Durumu</b>\nEtkin dil: ${langs.join(', ') || '—'}\n` +
      `Kuyruk: ${q.map((r) => `${r.status}=${r.c}`).join(' · ') || 'boş'}\n` +
      `Çevrilen: ${tr.map((r) => `${r.target_lang}:${r.c}`).join(', ') || '—'}`,
      { parse_mode: 'HTML', reply_markup: back('admin2_languages') }
    ).catch(() => {});
  });

  // ---------------- Watchdog alerts --------------------------------------------
  bot.action('admin2_alerts', adminMiddleware, (ctx) => {
    const alerts = db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 10').all();
    const events = db.prepare('SELECT * FROM margin_events ORDER BY id DESC LIMIT 10').all();
    let text = '🚨 <b>Uyarılar</b> (son 10)\n\n';
    if (!alerts.length && !events.length) text += '<i>Henüz uyarı yok.</i>';
    for (const a of alerts) text += `💸 ${a.kind} · supplier#${a.supplier_id} · ${a.payload} · ${a.created_at}\n`;
    for (const e of events) text += `⚠️ ${e.kind} · ürün#${e.product_id} · %${e.best_margin_pct ?? '?'}→%${e.served_margin_pct ?? '?'} · ${e.created_at}\n`;
    return ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🗑 Temizle', callback_data: 'admin2_alerts_clear' }], back('admin_api_menu')] }
    }).catch(() => {});
  });

  bot.action('admin2_alerts_clear', adminMiddleware, (ctx) => {
    db.prepare('DELETE FROM alerts').run();
    db.prepare('DELETE FROM margin_events').run();
    ctx.answerCbQuery('Temizlendi').catch(() => {});
    return ctx.editMessageText('🧹 Uyarılar temizlendi.', { reply_markup: back('admin_api_menu') }).catch(() => {});
  });

  // ---------------- Text-input states -------------------------------------------
  bot.on('message', async (ctx, next) => {
    if (!ctx.session || !ctx.session.adminState) return next();
    const state = ctx.session.adminState;

    if (state === 'waiting_new_category') {
      const raw = ctx.message.text.trim();
      if (!raw || raw.startsWith('/')) { ctx.session.adminState = null; return next(); }
      const m = raw.match(/^(\p{Extended_Pictographic}?)\s*/u);
      const emoji = m && m[1] ? m[1] : '📂';
      const name = raw.replace(/^(\p{Extended_Pictographic}?\s*)/u, '');
      const slug = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'kategori';
      const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) m FROM categories').get().m;
      const r = db.prepare('INSERT INTO categories (slug, name_json, emoji, sort_order) VALUES (?,?,?,?)')
        .run(slug, JSON.stringify({ en: name, tr: name }), emoji, maxSort + 1);
      ctx.session.adminState = null;
      return ctx.reply(`✅ Kategori #${r.lastInsertRowid} eklendi. Ürünleri "🔗 Ürünleri Kategorile" ile bağla.`, {
        reply_markup: back('admin2_categories')
      });
    }

    if (state === 'waiting_new_lang') {
      const raw = ctx.message.text.trim();
      if (!raw || raw.startsWith('/')) { ctx.session.adminState = null; return next(); }
      const [code, ...nameParts] = raw.split(/\s+/);
      const c = String(code).toLowerCase().replace(/[^a-z]/g, '').slice(0, 5);
      if (!c) return ctx.reply('Geçersiz dil kodu (örn: es İspanyolca).');
      const native = nameParts.join(' ') || c.toUpperCase();
      const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) m FROM languages').get().m;
      db.prepare(`INSERT INTO languages (code, name, native_name, enabled, sort_order) VALUES (?,?,?,1,?)
                  ON CONFLICT(code) DO UPDATE SET enabled = 1`).run(c, native, native, maxSort + 1);
      ctx.session.adminState = null;
      ctx.reply(`🌐 "${c}" eklendi — servis adları, ürünler ve menü metinleri çeviri kuyruğuna alındı.`, {
        reply_markup: back('admin2_lang_status')
      });
      require('../services/TranslationService').TranslationService
        .backfillLanguage(c).catch((e) => console.error('backfill failed:', e.message));
      return undefined;
    }

    return next();
  });
}

module.exports = setupAdminSuppliers2;
