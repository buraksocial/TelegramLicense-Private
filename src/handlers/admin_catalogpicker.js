/**
 * admin_catalogpicker — "API'den ürün ekle" akışı (Faz A).
 *
 * Admin hiçbir servis ID'si yazmaz: tedarikçiyi seçer, canlı katalogda
 * (supplier_catalogs snapshot'ı) gezer/aranır, servise dokunur; bot garanti
 * sınıfını isimden otomatik sınıflandırır, onaylatır, marj/taban sorar ve
 * ÇEVİRİ AJANI ürün adını + açıklamasını tüm aktif dillere LLM ile üretir.
 * Ürün + tedarikçi linki + kategori adayı otomatik oluşur.
 *
 * Callback'ler kısa tutulur: liste satırları session'da index'lenir
 * (Telegram callback_data 64 byte limiti).
 */
const { db } = require('../db');
const CatalogStore = require('../services/CatalogStore');
const { classifyWarranty, LABELS } = require('../utils/warranty');
const { parseMoney } = require('../utils/money');
const { TranslationService } = require('../services/TranslationService');

const PER_PAGE = 10;

function shortName(s, n = 40) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function setupCatalogPicker(bot, adminMiddleware) {
  // ---- entry --------------------------------------------------------------
  bot.action('acp_start', adminMiddleware, (ctx) => {
    const suppliers = db.prepare('SELECT * FROM suppliers WHERE enabled = 1 ORDER BY id').all();
    const keyboard = suppliers.map((s) => {
      const n = db.prepare('SELECT COUNT(*) c FROM supplier_catalogs WHERE supplier_id = ?').get(s.id).c;
      return [{ text: `🏢 ${s.name} (${n} servis)`, callback_data: `acp_b_${s.id}_1` }];
    });
    keyboard.push([{ text: '🔙 Geri', callback_data: 'admin_products_menu' }]);
    return ctx.editMessageText(
      '🧩 <b>Katalogdan Ürün Ekle</b>\n\n1️⃣ Tedarikçi seç\n2️⃣ Servisi gez/ara ve dokun\n3️⃣ Garanti sınıfı + marj onayı\n4️⃣ Agent isim/açıklamayı tüm dillerde üretir, ürün hazır olur.\n\nTedarikçi seç:',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
    ).catch(() => {});
  });

  // ---- browse --------------------------------------------------------------
  async function renderBrowse(ctx, supId, page, requery = false) {
    ctx.session = ctx.session || {};
    const cp = ctx.session.cp = ctx.session.cp || {};
    cp.supId = supId;
    cp.query = requery ? '' : (cp.query || '');
    cp.page = page;

    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supId);
    if (!supplier) return ctx.answerCbQuery('Tedarikçi yok.', { show_alert: true });

    let services = [];
    try {
      services = (await CatalogStore.getCatalog(supplier)) || [];
    } catch (e) { /* fall through to snapshot */ }
    if (!services.length) services = CatalogStore.readSnapshot(supplier.id);

    const q = (cp.query || '').toLowerCase();
    let rows = services
      .filter((s) => (s.stock === null || s.stock > 0))
      .filter((s) => !q || String(s.name || '').toLowerCase().includes(q) || String(s.price_usd || '').includes(q));
    rows.sort((a, b) => (a.price_usd ?? 1e9) - (b.price_usd ?? 1e9));

    const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
    page = Math.min(Math.max(1, page), pages);
    cp.page = page;
    const slice = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE);
    cp.rows = slice.map((r) => ({
      remote_service_id: r.remote_service_id, name: r.name, description: r.description,
      price_usd: r.price_usd, stock: r.stock, warranty: r.warranty
    }));

    const linkedIds = new Set(
      db.prepare('SELECT remote_service_id FROM product_suppliers WHERE supplier_id = ?').all(supId).map((r) => r.remote_service_id)
    );

    let text = `🧩 <b>${supplier.name}</b> — ${rows.length} uygun servis\nSayfa ${page}/${pages}` +
      (cp.query ? `\nArama: "${cp.query}"` : '') + '\n\n';
    const keyboard = [];
    slice.forEach((r, i) => {
      const w = classifyWarranty(r.name) === 'guaranteed' ? ' 🛡' : classifyWarranty(r.name) === 'instant' ? ' ⚡' : '';
      const lk = linkedIds.has(String(r.remote_service_id)) ? ' 🔗' : '';
      text += `#${i + 1} <b>$${r.price_usd ?? '?'}</b> · stok ${r.stock ?? '?'} · ${shortName(r.name)}${w}${lk}\n`;
      keyboard.push([{ text: `#${i + 1} ${shortName(r.name, 28)}`, callback_data: `acp_p_${i}` }]);
    });
    if (!slice.length) text += '\n<i>Servis bulunamadı — arama kelimesini değiştir veya başka tedarikçi dene.</i>';

    const nav = [];
    if (page > 1) nav.push({ text: '⬅️', callback_data: `acp_b_${supId}_${page - 1}` });
    nav.push({ text: '🔍 Ara', callback_data: 'acp_search' });
    if (page < pages) nav.push({ text: '➡️', callback_data: `acp_b_${supId}_${page + 1}` });
    keyboard.push(nav);
    keyboard.push([{ text: '🔙 Tedarikçiler', callback_data: 'acp_start' }]);

    return ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
  }

  bot.action(/^acp_b_(\d+)_(\d+)$/, adminMiddleware, (ctx) =>
    renderBrowse(ctx, parseInt(ctx.match[1], 10), parseInt(ctx.match[2], 10)));

  bot.action('acp_search', adminMiddleware, (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.adminState = 'acp_query';
    return ctx.editMessageText('🔍 Filtrelemek istediğin kelimeyi yaz (örn: gemini, spotify, warranty). Boş gönderirsen filtre temizlenir:', {
      reply_markup: { inline_keyboard: [[{ text: '❌ Vazgeç', callback_data: `acp_b_${(ctx.session.cp && ctx.session.cp.supId) || 1}_${(ctx.session.cp && ctx.session.cp.page) || 1}` }]] }
    }).catch(() => {});
  });

  // ---- pick a service ------------------------------------------------------
  bot.action(/^acp_p_(\d+)$/, adminMiddleware, (ctx) => {
    const cp = ctx.session && ctx.session.cp;
    if (!cp || !cp.rows || !cp.rows[parseInt(ctx.match[1], 10)]) {
      return ctx.answerCbQuery('Liste yenilenmedi, tekrar dene.', { show_alert: true });
    }
    const svc = cp.rows[parseInt(ctx.match[1], 10)];
    cp.pick = svc;
    const cls = classifyWarranty(svc.name);

    const keyboard = [
      [{ text: `⚡ Anlık kullanım — ${LABELS.instant}`, callback_data: 'acp_w_instant' }],
      [{ text: `🛡 Garantili — ${LABELS.guaranteed}`, callback_data: 'acp_w_guaranteed' }],
      [{ text: `🧩 Klasik (filtre yok) — ${LABELS.none}`, callback_data: 'acp_w_none' }],
      [{ text: '🔙 Listeye dön', callback_data: `acp_b_${cp.supId}_${cp.page || 1}` }]
    ];
    return ctx.editMessageText(
      `🧩 <b>Servis seçildi</b>\n\n${svc.name}\n📦 ID: <code>${svc.remote_service_id}</code>\n💵 maliyet: <b>$${svc.price_usd ?? '?'}</b> · stok ${svc.stock ?? '?'}\n` +
      `🏷 otomatik sınıflandırma: <b>${cls === 'unknown' ? LABELS.unknown : LABELS[cls]}</b>\n\n` +
      `<b>ÖNEMLİ:</b> Garantili ürünü ASLA anlık servisten teslim etmeyiz; anlık ürün garantili stoktan da almaz. ` +
      `Bu ürün hangi sınıfta satılacak?`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
    ).catch(() => {});
  });

  bot.action(/^acp_w_(instant|guaranteed|none)$/, adminMiddleware, (ctx) => {
    const cp = ctx.session && ctx.session.cp;
    if (!cp || !cp.pick) return ctx.answerCbQuery('Önce servis seç.', { show_alert: true });
    cp.warranty = ctx.match[1];
    ctx.session.adminState = 'acp_margin';
    return ctx.editMessageText(
      `Sınıf: <b>${LABELS[cp.warranty]}</b>\n\nMarj (%) yaz — $${cp.pick.price_usd ?? '?'} maliyete uygulanır ` +
      `(örn: 150 → satış $${((cp.pick.price_usd || 0) * 2.5).toFixed(2)}). Boş/balık git: 150`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Vazgeç', callback_data: 'acp_start' }]] } }
    ).catch(() => {});
  });

  // ---- create product (agent writes copy) ----------------------------------
  async function finalize(ctx, margin, floor) {
    const cp = ctx.session.cp;
    const svc = cp.pick;
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(cp.supId);
    const langs = db.prepare('SELECT code FROM languages WHERE enabled = 1 ORDER BY sort_order').all().map((r) => r.code);
    const baseLangs = ['en', ...langs].filter((l, i, a) => a.indexOf(l) === i);

    const status = await ctx.reply('🪄 <b>Agent ürün içeriğini üretiyor…</b>\n(İsim + açıklama tüm dillerde LLM ile yazılıyor, sipariş linki kuruluyor)', { parse_mode: 'HTML' });

    let copies = {};
    try {
      copies = await TranslationService.generateProductCopy(svc.name, svc.description || '', baseLangs, `supplier: ${supplier.name}`);
    } catch (e) {
      console.error('copy gen failed:', e.message);
    }
    const names = {}; const descs = {};
    for (const l of baseLangs) {
      const c = copies[l];
      names[l] = c ? c.name : (l === 'tr' ? svc.name : svc.name);
      if (c && c.description) descs[l] = c.description;
    }

    const sellUnit = Math.max((svc.price_usd || 0) * (1 + margin / 100), floor || 0);
    const info = db.prepare(
      `INSERT INTO products (name, description, price, cost_usd, pricing_mode, warranty, default_margin_percent, default_floor_price, supplier_selection_mode, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,1)`
    ).run(
      JSON.stringify(names), JSON.stringify(descs),
      Math.round(sellUnit * 100) / 100, svc.price_usd ?? 0,
      'max_profit', cp.warranty, margin, floor || 0, 'cheapest'
    );
    const productId = info.lastInsertRowid;

    db.prepare(
      `INSERT INTO product_suppliers (product_id, supplier_id, remote_service_id, priority, margin_percent, floor_price, warranty, last_price_usd, last_stock)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(productId, cp.supId, String(svc.remote_service_id), 1, margin, floor || 0, 'auto', svc.price_usd ?? null, svc.stock ?? null);

    // auto-category by name words
    try {
      const cats = db.prepare('SELECT * FROM categories').all();
      const nl = String(svc.name).toLowerCase();
      for (const c of cats) {
        const words = c.slug.toLowerCase().split(/[^a-z0-9çğıöşü]+/).filter((w) => w.length > 2);
        if (words.some((w) => nl.includes(w))) {
          db.prepare('INSERT OR IGNORE INTO product_categories (product_id, category_id) VALUES (?,?)').run(productId, c.id);
          break;
        }
      }
    } catch (e) { /* optional */ }

    // queue translation of the raw service name/desc for menu display too
    TranslationService.enqueue('catalog', cp.supId, 'name', svc.name, 'new');
    if (svc.description) TranslationService.enqueue('catalog', cp.supId, 'desc', svc.description, 'new');

    const wBadge = cp.warranty === 'guaranteed' ? '🛡' : cp.warranty === 'instant' ? '⚡' : '🧩';
    return ctx.reply(
      `✅ <b>Ürün oluşturuldu #${productId}</b> ${wBadge}\n\n` +
      `📛 ${names.tr || names.en}\n💰 Satış: <b>$${sellUnit.toFixed(2)}</b} (maliyet $${svc.price_usd ?? '?'}, marj %${margin}${floor ? `, taban $${floor}` : ''})\n` +
      `🔗 ${supplier.name} · servis <code>${svc.remote_service_id}</code>\n🧠 Fiyat modu: max_profit (dinamik)\n\n` +
      `✏️ İstersen Ürün Yönetimi'nden düzenle; marj/taban/link ayarları orada da var.`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[
          { text: '📦 Ürünler', callback_data: 'admin_products_menu' },
          { text: '➕ Bir Tane Daha', callback_data: 'acp_start' }
        ]] }
      }
    ).then(() => { if (status && ctx.telegram) ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {}); });
  }

  // ---- text states ----------------------------------------------------------
  bot.on('message', async (ctx, next) => {
    const cp = ctx.session && ctx.session.cp;
    const state = ctx.session && ctx.session.adminState;
    if (!state || !state.startsWith('acp_')) return next();

    const raw = (ctx.message.text || '').trim();

    if (state === 'acp_query') {
      ctx.session.adminState = null;
      cp.query = raw && !raw.startsWith('/') ? raw : '';
      return renderBrowse(ctx, cp.supId, 1, false);
    }

    if (state === 'acp_margin') {
      const m = raw && !raw.startsWith('/') ? parseMoney(raw) : 150;
      if (m === null || m < 0 || m > 100000) return ctx.reply('Geçersiz marj (örn: 150). Tekrar yaz, / ile iptal:');
      cp.margin = m;
      ctx.session.adminState = 'acp_floor';
      return ctx.reply(`Marj %${m} ✅ — İsteğe bağlı TABAN fiyat (USD, örn: 3.5). Boş geçersek marj fiyatı kullanılır. / ile iptal.`);
    }

    if (state === 'acp_floor') {
      const f = raw && !raw.startsWith('/') ? parseMoney(raw) : 0;
      if (f === null || f < 0) return ctx.reply('Geçersiz taban (örn: 3.5). Tekrar yaz, / ile iptal:');
      ctx.session.adminState = null;
      const floor = f || 0;
      await finalize(ctx, cp.margin ?? 150, floor);
      delete ctx.session.cp;
      return undefined;
    }

    if (raw.startsWith('/')) {
      ctx.session.adminState = null;
      delete ctx.session.cp;
      return ctx.reply('İptal edildi.', {
        reply_markup: { inline_keyboard: [[{ text: '🧩 Katalogdan Ekle', callback_data: 'acp_start' }]] }
      });
    }
    return next();
  });

  return { renderBrowse };
}

module.exports = setupCatalogPicker;
