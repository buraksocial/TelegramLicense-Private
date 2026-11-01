const { db } = require('../db');
const { broadcastMessage } = require('../bot');
const { sendWalletTopUpLog, sendRestockLog } = require('../utils/logger');
const { ADMIN_ID } = require('../config/env');
const axios = require('axios');
const { t } = require('../utils/i18n');
const setupAdminApiHandlers = require('./admin_api');
const SupplierManager = require('../services/SupplierManager');
const { parseMoney } = require('../utils/money');

function getUserLang(userId) {
  const user = db.prepare('SELECT lang FROM users WHERE id = ?').get(userId);
  return user?.lang || 'en';
}

function setupAdminHandlers(bot) {
  const adminMiddleware = (ctx, next) => {
    if (ctx.from.id === ADMIN_ID) {
      return next();
    }
  };

  const showAdminMenu = (ctx, edit = false) => {
    const lang = getUserLang(ctx.from.id);
    const text = t(lang, 'admin_welcome') || '👨‍💻 <b>Admin Paneline Hoş Geldiniz!</b>\nLütfen yapmak istediğiniz işlemi seçin:';
    const opts = {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📦 Ürün Yönetimi', callback_data: 'admin_products_menu' }],
          [{ text: t(lang, 'admin_pricing_groups') || '🏢 Fiyat Grupları Yönetimi', callback_data: 'admin_pricing_groups_menu' }],
          [{ text: t(lang, 'admin_balance_mgr') || '💼 Bakiye Yönetimi', callback_data: 'admin_balance_menu' }, { text: t(lang, 'admin_promo') || '🎟 Promo Kod', callback_data: 'admin_promo_menu' }],
          [{ text: t(lang, 'admin_rank') || '🏆 Rank Sistemi', callback_data: 'admin_rank_menu' }, { text: t(lang, 'admin_reseller') || '🤝 Bayi Yön.', callback_data: 'admin_reseller_menu' }],
          [{ text: '📦 Manuel Satış', callback_data: 'admin_ms_menu' }, { text: t(lang, 'admin_stats') || '📊 Kazanç İstatistikleri', callback_data: 'admin_stats_menu' }],
          [{ text: t(lang, 'admin_api') || '⚙️ API & Otomatik Stok', callback_data: 'admin_api_menu' }, { text: t(lang, 'admin_settings') || '🛠 Genel Ayarlar', callback_data: 'admin_settings_menu' }],
          [{ text: '📝 Son Siparişler / Rezervasyonlar', callback_data: 'admin_recent_orders_menu' }],
          [{ text: t(lang, 'admin_cancel') || '❌ İptal', callback_data: 'admin_cancel' }]
        ]
      }
    };
    if (edit) {
      ctx.editMessageText(text, opts).catch(e => {});
    } else {
      ctx.reply(text, opts).catch(e => {});
    }
  };

  bot.command('admin', adminMiddleware, (ctx) => {
    if (ctx.session) ctx.session.adminState = null;
    showAdminMenu(ctx, false);
  });

  bot.command('setresfee', adminMiddleware, (ctx) => {
    const parts = ctx.message.text.split(' ');
    if (parts.length !== 3) {
      return ctx.reply('Kullanım: /setresfee <user_id> <ücret>\nSıfırlamak için ücret yerine "clear" yazın.');
    }
    const userId = parseInt(parts[1], 10);
    const feeStr = parts[2].toLowerCase();
    
    if (isNaN(userId)) return ctx.reply('Geçersiz kullanıcı ID.');
    
    if (feeStr === 'clear' || feeStr === 'null') {
       const res = db.prepare('UPDATE users SET custom_reservation_fee = NULL WHERE id = ?').run(userId);
       if (res.changes === 0) return ctx.reply('Kullanıcı bulunamadı!');
       return ctx.reply(`Kullanıcı ${userId} için özel rezerve ücreti kaldırıldı. Sistem varsayılanı kullanılacak.`);
    }
    
    const fee = parseMoney(feeStr);
    if (fee === null || fee < 0) return ctx.reply('Geçersiz ücret miktarı.');
    
    const res = db.prepare('UPDATE users SET custom_reservation_fee = ? WHERE id = ?').run(fee, userId);
    if (res.changes === 0) return ctx.reply('Kullanıcı bulunamadı!');
    ctx.reply(`Kullanıcı ${userId} için özel rezerve ücreti ${fee} olarak ayarlandı.`);
  });

  bot.command('botstats', adminMiddleware, (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const row = db.prepare('SELECT COUNT(*) AS total FROM users').get();
    const count = row ? row.total : 0;
    ctx.reply(t(lang, 'bot_stats_msg', { count }), { parse_mode: 'HTML' });
  });

  bot.action('admin_cancel', adminMiddleware, (ctx) => {
    const lang = getUserLang(ctx.from.id);
    if (ctx.session) ctx.session.adminState = null;
    ctx.editMessageText(t(lang, 'admin_cancelled') || '✅ Admin işlemi iptal edildi.');
  });

  // --- ÜRÜN EKLEME AKIŞI ---
  bot.action('admin_add_product', adminMiddleware, (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.adminState = 'waiting_product_name';
    
    ctx.editMessageText('📦 <b>Yeni Ürün Ekleme</b>\nLütfen eklenecek ürünün <b>ismini</b> yazarak gönderin:\n\n<i>İptal etmek için /admin komutunu tekrar girebilirsiniz.</i>', { parse_mode: 'HTML' });
  });

  // --- STOK EKLEME AKIŞI ---
  bot.action(/^admin_ms_menu(?:_(\d+))?$/, adminMiddleware, (ctx) => {
    const page = parseInt(ctx.match[1] || 1, 10);
    const limit = 10;
    const offset = (page - 1) * limit;

    const totalCount = db.prepare('SELECT COUNT(*) as count FROM products').get().count;
    if (totalCount === 0) {
      return ctx.answerCbQuery('Hiç ürün yok! Önce ürün eklemelisiniz.', { show_alert: true });
    }

    const products = db.prepare('SELECT * FROM products WHERE is_active = 1 LIMIT ? OFFSET ?').all(limit, offset);

    const buttons = products.map(p => {
      let name = p.name;
      try {
        const parsed = JSON.parse(name);
        name = parsed['tr'] || parsed['en'] || name;
      } catch (e) {}
      return [{ text: name, callback_data: `admin_ms_prod_${p.id}` }];
    });

    const navButtons = [];
    if (page > 1) navButtons.push({ text: '⬅️ Önceki', callback_data: `admin_ms_menu_${page - 1}` });
    if (offset + limit < totalCount) navButtons.push({ text: 'Sonraki ➡️', callback_data: `admin_ms_menu_${page + 1}` });

    if (navButtons.length > 0) buttons.push(navButtons);
    buttons.push([{ text: '🔙 Geri Dön', callback_data: 'admin_back_main' }]);

    ctx.editMessageText(`📦 <b>Manuel Satış (Sayfa ${page})</b>\nLütfen satmak istediğiniz ürünü seçin:`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: buttons
      }
    }).catch(e => {});
  });

  bot.action(/^admin_ms_prod_(\d+)$/, adminMiddleware, async (ctx) => {
    try {
      const productId = parseInt(ctx.match[1], 10);
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!product) return ctx.answerCbQuery('Ürün bulunamadı!', { show_alert: true });

      ctx.session = ctx.session || {};
      ctx.session.adminState = `waiting_ms_qty_${productId}`;
      
      let prodName = product.name;
      try {
        const parsed = JSON.parse(prodName);
        prodName = parsed['tr'] || parsed['en'] || prodName;
      } catch(e) {}
      
      await ctx.editMessageText(`📦 <b>Manuel Satış:</b> ${prodName}\n\nLütfen bu üründen kaç adet satılacağını yazın (Örn: 20):`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: 'admin_cancel' }]] }
      });
      await ctx.answerCbQuery().catch(() => null);
    } catch (error) {
      console.error('admin_ms_prod_ error:', error);
      ctx.answerCbQuery('Bir hata oluştu!').catch(() => null);
    }
  });

  bot.action(/^admin_products_menu(?:_(\d+))?$/, adminMiddleware, (ctx) => {
    const page = parseInt(ctx.match[1] || 1, 10);
    const limit = 10;
    const offset = (page - 1) * limit;

    const totalCount = db.prepare('SELECT COUNT(*) as count FROM products').get().count;
    const products = db.prepare('SELECT * FROM products WHERE is_active = 1 LIMIT ? OFFSET ?').all(limit, offset);
    
    const buttons = products.map(p => {
      let name = p.name;
      try {
        const parsed = JSON.parse(name);
        name = parsed['tr'] || parsed['en'] || name;
      } catch (e) {}
      return [{ text: name, callback_data: `admin_product_detail_${p.id}` }];
    });

    const navButtons = [];
    if (page > 1) navButtons.push({ text: '⬅️ Önceki', callback_data: `admin_products_menu_${page - 1}` });
    if (offset + limit < totalCount) navButtons.push({ text: 'Sonraki ➡️', callback_data: `admin_products_menu_${page + 1}` });
    if (navButtons.length > 0) buttons.push(navButtons);
    
    buttons.unshift([{ text: '➕ Yeni Ürün Ekle', callback_data: 'admin_add_product' }]);
    buttons.unshift([{ text: '🧩 Katalogdan Ürün Ekle (API)', callback_data: 'acp_start' }]);
    buttons.push([{ text: '🔙 Ana Menü', callback_data: 'admin_back_main' }]);

    ctx.editMessageText(`📦 <b>Ürün Yönetimi (Sayfa ${page})</b>\nLütfen detaylarını görmek istediğiniz ürünü seçin:`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }).catch(e => {});
  });

  bot.action(/^admin_product_detail_(\d+)$/, adminMiddleware, async (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) return ctx.answerCbQuery('Ürün bulunamadı!', { show_alert: true });

    const stockCount = db.prepare('SELECT COUNT(*) as c FROM stocks WHERE product_id = ? AND is_sold = 0').get(productId).c;
    
    let name = product.name;
    try {
      const parsed = JSON.parse(name);
      name = parsed['tr'] || parsed['en'] || name;
    } catch (e) {}

    // live offers (governor-safe; falls back to snapshot)
    let pricingBlock = '';
    let offerButtons = [];
    try {
      const { PricingEngine } = require('../services/PricingEngine');
      const decision = await PricingEngine.price(product, { qty: 1 });
      const MODE_LABEL = { max_profit: '📈 Maks. Kâr', cheapest: '💸 En Ucuz', manual: '✍️ Manuel' };
      pricingBlock = `\n\n🧮 <b>Fiyalama modu:</b> ${MODE_LABEL[decision.mode] || decision.mode}` +
        `  |  <b>Teslimat:</b> ${decision.fulfillment_mode}` +
        `\n🏷 <b>.varsayılan</b> kâr: %${product.default_margin_percent ?? 150} — alt limit: $${product.default_floor_price || 0}` +
        (decision.soldOut
          ? '\n🔴 <b>ŞU AN TÜKENDİ</b> — hiçbir tedarikçi (bakiye/stok) teslim edemiyor.'
          : `\n👁 Müşteri fiyatı: <b>$${decision.displayUnit}</b>` +
            (decision.fulfillOffer ? `  |  Kaynak: ${decision.fulfillOffer.supplier_name} ($${decision.fulfillOffer.unitCost})` : ''));

      offerButtons = decision.all.slice(0, 8).map((o) => [{
        text: `${o.affordable ? '🟢' : '🔴'} ${o.supplier_name} | $${o.unitCost} → $${o.sellUnit} ${o.realStock != null ? `(${o.realStock})` : ''}`,
        callback_data: `admin_prod_sup_detail_${productId}_${o.product_supplier_id}`
      }]);
    } catch (e) {
      console.error('product pricing detail failed:', e.message);
    }

    const W = { none: '🧩 Klasik', guaranteed: '🛡 Garantili', instant: '⚡ Anlık' };
    const text = `📦 <b>Ürün Detayı:</b> ${name}\n\n💵 <b>Satış Fiyatı:</b> ${product.price} USD\n💰 <b>Birim Maliyet:</b> ${product.cost_usd || 0} USD\n🛒 <b>Mevcut Stok:</b> ${stockCount} adet\n🛡 <b>Garanti sınıfı:</b> ${W[product.warranty] || W.none}${pricingBlock}`;

    ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          ...offerButtons,
          [{ text: '➕ Stok Ekle', callback_data: `admin_sel_stock_${productId}` }],
          [{ text: '📝 İsmini Düzenle', callback_data: `admin_prod_edit_name_${productId}` }],
          [{ text: '💵 Fiyat/Maliyet Düzenle', callback_data: `admin_prod_edit_price_${productId}` }],
          [{ text: '🛡 Garanti sınıfı değiştir', callback_data: `admin_prod_warranty_${productId}` }],
          [{ text: '🧮 Fiyalama Modu / Kâr / Alt Limit', callback_data: `admin_prod_pricing_${productId}` }],
          [{ text: '🎁 Toplu Alım Kuralları', callback_data: `admin_prod_bulk_${productId}` }],
          [{ text: '📈 Tüm Fiyatlara Zam Yap (%)', callback_data: `admin_prod_increase_${productId}` }],
          [{ text: '🗑 Ürünü Sil', callback_data: `admin_prod_del_confirm_${productId}` }],
          [{ text: '🔙 Ürün Listesine Dön', callback_data: 'admin_products_menu' }]
        ]
      }
    }).catch(e => {});
  });

  // ---- pricing mode + margin/floor editor ---------------------------------
  bot.action(/^admin_prod_pricing_(\d+)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) return ctx.answerCbQuery('Ürün bulunamadı!', { show_alert: true });

    const modeBtns = [
      { text: product.pricing_mode === 'max_profit' ? '✅ ' : '', callback_data: `admin_prod_mode_${productId}_max_profit`, label: '📈 Maks. Kâr (floor dikkate alınır)' },
      { text: product.pricing_mode === 'cheapest' ? '✅ ' : '', callback_data: `admin_prod_mode_${productId}_cheapest`, label: '💸 En Ucuz (müşteriya düşük teklif)' },
      { text: product.pricing_mode === 'manual' ? '✅ ' : '', callback_data: `admin_prod_mode_${productId}_manual`, label: '✍️ Manuel (sabit fiyat)' }
    ].map((b) => [{ text: `${b.text}${b.label}`, callback_data: b.callback_data }]);

    const fmodeBtns = [
      ['cheapest', 'Teslimat: en ucuz tedarikçiden'],
      ['priority', 'Teslimat: öncelik sırasına göre'],
      ['optimal', 'Teslimat: toplu/optimal bölünme']
    ].map(([m, label]) => [{
      text: `${product.supplier_selection_mode === m || (!product.supplier_selection_mode && m === 'cheapest') ? '✅ ' : ''}${label}`,
      callback_data: `admin_prod_fmode_${productId}_${m}`
    }]);

    ctx.editMessageText(
      `🧮 <b>Fiyalama & Kâr — Ürün #${productId}</b>\n\n` +
      `Mevcut mod: <b>${product.pricing_mode || 'max_profit'}</b>\n` +
      `Teslimat: <b>${product.supplier_selection_mode || 'cheapest'}</b>\n` +
      `Varsayılan kâr: <b>%${product.default_margin_percent ?? 150}</b>\n` +
      `Alt limit: <b>$${product.default_floor_price || 0}</b>\n\n` +
      `<i>Alt limit: 0.60$'a aldığın ürünü en fazla 3.00$'ın altına düşürmez.\n` +
      `Teslimat "en ucuz" iken müşteri pahalı tekliften ödediyse fark senin kârın kalır.</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            ...modeBtns,
            ...fmodeBtns,
            [{ text: `🎯 Varsayılan kâr %${product.default_margin_percent ?? 150} değiştir`, callback_data: `admin_prod_margin_${productId}` }],
            [{ text: `⬇️ Alt limit $${product.default_floor_price || 0} değiştir`, callback_data: `admin_prod_floor_${productId}` }],
            [{ text: '🔙 Ürüne Dön', callback_data: `admin_product_detail_${productId}` }]
          ]
        }
      }
    ).catch(e => {});
  });

  bot.action(/^admin_prod_mode_(\d+)_(max_profit|cheapest|manual)$/, adminMiddleware, async (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    db.prepare('UPDATE products SET pricing_mode = ? WHERE id = ?').run(ctx.match[2], productId);
    ctx.answerCbQuery('Güncellendi').catch(() => {});
    // re-open pricing screen (regex below handles the render)
    return openPricingScreen(ctx, productId);
  });

  bot.action(/^admin_prod_fmode_(\d+)_(cheapest|priority|optimal)$/, adminMiddleware, async (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    db.prepare('UPDATE products SET supplier_selection_mode = ? WHERE id = ?').run(ctx.match[2], productId);
    ctx.answerCbQuery('Güncellendi').catch(() => {});
    return openPricingScreen(ctx, productId);
  });

  async function openPricingScreen(ctx, productId) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) return ctx.editMessageText('Ürün bulunamadı.').catch(() => {});
    const MODE_LABEL = { max_profit: '📈 Maks. Kâr', cheapest: '💸 En Ucuz', manual: '✍️ Manuel' };
    const sel = product.supplier_selection_mode || 'cheapest';
    ctx.editMessageText(
      `🧮 <b>Fiyalama & Kâr — Ürün #${productId}</b>\n\n` +
      `Mevcut mod: <b>${MODE_LABEL[product.pricing_mode] || product.pricing_mode}</b>\n` +
      `Teslimat: <b>${sel}</b>\n` +
      `Varsayılan kâr: <b>%${product.default_margin_percent ?? 150}</b>\n` +
      `Alt limit: <b>$${product.default_floor_price || 0}</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📈 Maks. Kâr', callback_data: `admin_prod_mode_${productId}_max_profit` }],
            [{ text: '💸 En Ucuz', callback_data: `admin_prod_mode_${productId}_cheapest` }],
            [{ text: '✍️ Manuel', callback_data: `admin_prod_mode_${productId}_manual` }],
            [{ text: '🏭 Teslimat: en ucuz', callback_data: `admin_prod_fmode_${productId}_cheapest` }],
            [{ text: '🏭 Teslimat: öncelik', callback_data: `admin_prod_fmode_${productId}_priority` }],
            [{ text: '🏭 Teslimat: optimal', callback_data: `admin_prod_fmode_${productId}_optimal` }],
            [{ text: `🎯 Kâr %${product.default_margin_percent ?? 150} değiştir`, callback_data: `admin_prod_margin_${productId}` }],
            [{ text: `⬇️ Alt limit $${product.default_floor_price || 0} değiştir`, callback_data: `admin_prod_floor_${productId}` }],
            [{ text: '🔙 Ürüne Dön', callback_data: `admin_product_detail_${productId}` }]
          ]
        }
      }
    ).catch(() => {});
  }

  bot.action(/^admin_prod_margin_(\d+)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    ctx.session = ctx.session || {};
    ctx.session.adminState = `waiting_product_margin_${productId}`;
    ctx.editMessageText('🎯 Yeni <b>kâr yüzdesini</b> girin (Örn: 150 → maliyetin 2.5 katı satılır):', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: `admin_product_detail_${productId}` }]] }
    }).catch(() => {});
  });

  bot.action(/^admin_prod_floor_(\d+)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    ctx.session = ctx.session || {};
    ctx.session.adminState = `waiting_product_floor_${productId}`;
    ctx.editMessageText('⬇️ <b>Alt limit fiyatı (USD)</b> girin (0 = yok). Örn: 3 → hiçbir teklif 3$ altına satılmaz:', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: `admin_product_detail_${productId}` }]] }
    }).catch(() => {});
  });

  // ---- per-offer (product_suppliers) editor -------------------------------
  bot.action(/^admin_prod_sup_detail_(\d+)_(\d+)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    const psId = parseInt(ctx.match[2], 10);
    const link = db.prepare(
      `SELECT ps.*, s.name AS supplier_name, s.enabled AS supplier_enabled, s.type
       FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id WHERE ps.id = ?`
    ).get(psId);
    if (!link) return ctx.answerCbQuery('Bağlantı bulunamadı.', { show_alert: true });

    const { LABELS: W_LABELS } = require('../utils/warranty');
    const catRow = db.prepare('SELECT warranty, name FROM supplier_catalogs WHERE supplier_id = ? AND remote_service_id = ?').get(link.supplier_id, link.remote_service_id);
    const autoCls = catRow ? (catRow.warranty || 'unknown') : 'unknown';
    const effW = link.warranty && link.warranty !== 'auto' ? link.warranty : `auto→${autoCls}`;

    const text =
      `🏭 <b>${link.supplier_name}</b> (${link.type})\nService: <code>${link.remote_service_id}</code>\n\n` +
      `Son bilinen maliyet: <b>${link.last_price_usd != null ? `$${link.last_price_usd}` : '?'}</b>` +
      ` | Stok: <b>${link.last_stock != null ? link.last_stock : '?'}</b>\n` +
      `Bğ.kâr: <b>${link.margin_percent != null ? `%${link.margin_percent}` : 'varsayılan'}</b>` +
      ` | Bğ.alt limit: <b>${link.floor_price != null ? `$${link.floor_price}` : 'varsayılan'}</b>\n` +
      `🛡 Garanti sınıfı: <b>${W_LABELS[effW] || effW}</b>\n` +
      `Durum: ${link.enabled ? '🟢 aktif' : '🔴 pasif'} (tedarikçi: ${link.supplier_enabled ? '🟢' : '🔴'})` +
      (link.note ? `\nNot: ${link.note}` : '');

    ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎯 Bu tedarikçi için kâr %', callback_data: `admin_link_margin_${productId}_${psId}` }],
          [{ text: '⬇️ Bu tedarikçi için alt limit', callback_data: `admin_link_floor_${productId}_${psId}` }],
          [{ text: `🛡 Garanti sınıfı: ${link.warranty || 'auto'} → değiştir`, callback_data: `admin_link_warranty_${productId}_${psId}` }],
          [{ text: link.enabled ? '🔴 Pasife al' : '🟢 Aktife al', callback_data: `admin_link_toggle_${productId}_${psId}` }],
          [{ text: '↕️ Önceliği değiştir', callback_data: `admin_link_priority_${productId}_${psId}` }],
          [{ text: '🗑 Bağlantıyı sil', callback_data: `admin_link_del_${productId}_${psId}` }],
          [{ text: '🔙 Ürüne Dön', callback_data: `admin_product_detail_${productId}` }]
        ]
      }
    }).catch(() => {});
  });

  bot.action(/^admin_link_toggle_(\d+)_(\d+)$/, adminMiddleware, (ctx) => {
    const [, productId, psId] = ctx.match.map(Number);
    db.prepare('UPDATE product_suppliers SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END WHERE id = ?').run(psId);
    ctx.answerCbQuery('Durum değişti.').catch(() => {});
    return bot.handleUpdate({
      update_id: ctx.update.update_id,
      callback_query: { ...ctx.callbackQuery, data: `admin_prod_sup_detail_${productId}_${psId}` }
    });
  });

  // link-level warranty override: auto → guaranteed → instant → mixed → auto
  bot.action(/^admin_link_warranty_(\d+)_(\d+)$/, adminMiddleware, (ctx) => {
    const [, productId, psId] = ctx.match.map(Number);
    const { LABELS: W_LABELS } = require('../utils/warranty');
    const link = db.prepare('SELECT warranty FROM product_suppliers WHERE id = ?').get(psId);
    const order = ['auto', 'guaranteed', 'instant', 'mixed'];
    const cur = order.indexOf((link && link.warranty) || 'auto');
    const nextW = order[(cur + 1) % order.length];
    db.prepare('UPDATE product_suppliers SET warranty = ? WHERE id = ?').run(nextW, psId);
    ctx.answerCbQuery(`Sınıf: ${W_LABELS[nextW] || nextW}`).catch(() => {});
    return bot.handleUpdate({
      update_id: ctx.update.update_id,
      callback_query: { ...ctx.callbackQuery, data: `admin_prod_sup_detail_${productId}_${psId}` }
    });
  });

  bot.action(/^admin_link_priority_(\d+)_(\d+)$/, adminMiddleware, (ctx) => {
    const [, productId, psId] = ctx.match.map(Number);
    const link = db.prepare('SELECT * FROM product_suppliers WHERE id = ?').get(psId);
    const next = db.prepare('SELECT COALESCE(MAX(priority),0)+1 m FROM product_suppliers WHERE product_id = ?').get(productId).m;
    db.prepare('UPDATE product_suppliers SET priority = ? WHERE id = ?').run(link.priority >= next ? 1 : link.priority + 1, psId);
    ctx.answerCbQuery('Öncelik değişti.').catch(() => {});
    return bot.handleUpdate({
      update_id: ctx.update.update_id,
      callback_query: { ...ctx.callbackQuery, data: `admin_prod_sup_detail_${productId}_${psId}` }
    });
  });

  bot.action(/^admin_link_del_(\d+)_(\d+)$/, adminMiddleware, (ctx) => {
    const [, productId, psId] = ctx.match.map(Number);
    const link = db.prepare('SELECT * FROM product_suppliers WHERE id = ?').get(psId);
    db.prepare('DELETE FROM product_suppliers WHERE id = ?').run(psId);
    if (link) {
      db.prepare("UPDATE product_matches SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE supplier_id = ? AND remote_service_id = ?")
        .run(link.supplier_id, link.remote_service_id);
    }
    ctx.answerCbQuery('Bağlantı silindi.').catch(() => {});
    return bot.handleUpdate({
      update_id: ctx.update.update_id,
      callback_query: { ...ctx.callbackQuery, data: `admin_product_detail_${productId}` }
    });
  });

  bot.action(/^admin_link_margin_(\d+)_(\d+)$/, adminMiddleware, (ctx) => {
    const [, productId, psId] = ctx.match.map(Number);
    ctx.session = ctx.session || {};
    ctx.session.adminState = `waiting_link_margin_${productId}_${psId}`;
    ctx.editMessageText('🎯 Bu bağlantı için <b>kâr yüzdesi</b> girin (boş = ürün varsayılanına dön, "clear" yazın):', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: `admin_prod_sup_detail_${productId}_${psId}` }]] }
    }).catch(() => {});
  });

  bot.action(/^admin_link_floor_(\d+)_(\d+)$/, adminMiddleware, (ctx) => {
    const [, productId, psId] = ctx.match.map(Number);
    ctx.session = ctx.session || {};
    ctx.session.adminState = `waiting_link_floor_${productId}_${psId}`;
    ctx.editMessageText('⬇️ Bu bağlantı için <b>alt limit (USD)</b> girin ("clear" = ürün varsayılanı):', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: `admin_prod_sup_detail_${productId}_${psId}` }]] }
    }).catch(() => {});
  });

  bot.action(/^admin_prod_increase_(\d+)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    ctx.session = ctx.session || {};
    ctx.session.adminState = `waiting_price_increase_${productId}`;
    ctx.editMessageText('Yüzdelik dilimde ne kadar zam yapmak istiyorsunuz? (Örn: %20 zam için 20 yazın. İndirim için -20 yazabilirsiniz.)', {
      reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: `admin_product_detail_${productId}` }]] }
    }).catch(e => {});
  });

  bot.action(/^admin_prod_edit_name_(\d+)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    ctx.session = ctx.session || {};
    ctx.session.adminState = `waiting_edit_name_${productId}`;
    ctx.editMessageText('📝 <b>İsim Güncelleme</b>\nLütfen ürünün yeni <b>İsmini</b> girin (Örn: Spotify 18 Aylık Kod):', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: `admin_product_detail_${productId}` }]] }
    }).catch(e => {});
  });

  bot.action(/^admin_prod_edit_price_(\d+)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    ctx.session = ctx.session || {};
    ctx.session.adminState = `waiting_edit_price_${productId}`;
    ctx.editMessageText('💵 <b>Fiyat Güncelleme</b>\nLütfen ürünün yeni <b>Satış Fiyatını (USD)</b> girin (Örn: 15 veya 10.5):', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: `admin_product_detail_${productId}` }]] }
    }).catch(e => {});
  });

  // 🛡 Garanti sınıfı: garantili ürün SADECE garantili servisten teslim edilir;
  // anlık ürün garantili stoktan almaz; klasik = filtre yok (eski davranış).
  bot.action(/^admin_prod_warranty_(\d+)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    const p = db.prepare('SELECT warranty FROM products WHERE id = ?').get(productId);
    const mark = (w) => ((p.warranty || 'none') === w ? '✅ ' : '') + (w === 'guaranteed' ? '🛡 Garantili' : w === 'instant' ? '⚡ Anlık Kullanım' : '🧩 Klasik (filtresiz)');
    ctx.editMessageText(
      '🛡 <b>Garanti sınıfı</b>\n\n' +
      '🛡 Garantili → teslimat SADECE garantili servislerden\n' +
      '⚡ Anlık → garantili stok SUNULMAZ ve teslim edilmez\n' +
      '🧩 Klasik → filtre yok (mevcut davranış)\n\nSeç:',
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: mark('guaranteed'), callback_data: `admin_prod_wset_${productId}_guaranteed` }],
            [{ text: mark('instant'), callback_data: `admin_prod_wset_${productId}_instant` }],
            [{ text: mark('none'), callback_data: `admin_prod_wset_${productId}_none` }],
            [{ text: '🔙 Ürün', callback_data: `admin_product_detail_${productId}` }]
          ]
        }
      }
    ).catch(e => {});
  });

  bot.action(/^admin_prod_wset_(\d+)_(none|guaranteed|instant)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    db.prepare('UPDATE products SET warranty = ? WHERE id = ?').run(ctx.match[2], productId);
    ctx.answerCbQuery('Garanti sınıfı güncellendi ✓').catch(() => {});
    return bot.handleUpdate({
      update_id: ctx.update.update_id,
      callback_query: { ...ctx.callbackQuery, data: `admin_product_detail_${productId}` }
    });
  });

  bot.action(/^admin_prod_del_confirm_(\d+)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    ctx.editMessageText('⚠️ <b>Emin misiniz?</b>\nBu ürünü ve ona ait tüm stok/indirim bilgilerini kalıcı olarak silmek üzeresiniz!', {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗑 EVET, SİL', callback_data: `admin_prod_del_${productId}` }],
          [{ text: '❌ İptal', callback_data: `admin_product_detail_${productId}` }]
        ]
      }
    }).catch(e => {});
  });

  bot.action(/^admin_prod_del_(\d+)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(productId);
    db.prepare('DELETE FROM stocks WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM product_bulk_discounts WHERE product_id = ?').run(productId);
    ctx.answerCbQuery('Ürün başarıyla silindi!', { show_alert: true }).catch(()=>null);
    ctx.session = ctx.session || {};
    ctx.session.adminState = null;
    ctx.editMessageText('✅ Ürün ve ilişkili tüm veriler silindi.', {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Ürün Yönetimine Dön', callback_data: 'admin_products_menu' }]] }
    }).catch(e => {});
  });

  bot.action(/^admin_prod_bulk_(\d+)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) return ctx.answerCbQuery('Ürün bulunamadı!');

    const rules = db.prepare('SELECT * FROM product_bulk_discounts WHERE product_id = ? ORDER BY min_qty ASC').all(productId);
    
    let text = `🎁 <b>Toplu Alım Kuralları</b>\nÜrün: ID ${productId}\n\n`;
    const buttons = [];

    if (rules.length === 0) {
      text += `<i>Bu ürün için henüz indirim kuralı yok.</i>\n\n`;
    } else {
      rules.forEach(r => {
        let discountStr = '';
        if (r.fixed_price !== null && r.fixed_price > 0) {
           discountStr = `$${r.fixed_price} sabit fiyat`;
        } else if (r.discount_percent > 0) {
           discountStr = `%${r.discount_percent} indirim`;
        } else {
           discountStr = `Bilinmeyen kural`;
        }
        text += `🔸 <b>${r.min_qty} Adet ve üzeri:</b> ${discountStr}\n`;
        buttons.push([{ text: `🗑 Sil: ${r.min_qty} Adet Kuralı`, callback_data: `admin_prod_bulk_del_${r.id}_${productId}` }]);
      });
      text += `\n`;
    }

    buttons.push([{ text: '➕ Yeni Kural Ekle', callback_data: `admin_prod_bulk_add_qty_${productId}` }]);
    buttons.push([{ text: '🔙 Geri Dön', callback_data: `admin_product_detail_${productId}` }]);

    ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }).catch(e => {});
  });

  bot.action(/^admin_prod_bulk_del_(\d+)_(\d+)$/, adminMiddleware, (ctx) => {
    const ruleId = parseInt(ctx.match[1], 10);
    const productId = parseInt(ctx.match[2], 10);
    db.prepare('DELETE FROM product_bulk_discounts WHERE id = ?').run(ruleId);
    ctx.answerCbQuery('Kural silindi!').catch(()=>null);
    ctx.editMessageText('✅ Kural silindi.', { reply_markup: { inline_keyboard: [[{ text: '🔙 Kurallara Dön', callback_data: `admin_prod_bulk_${productId}` }]] } }).catch(e=>{});
  });

  bot.action(/^admin_prod_bulk_add_qty_(\d+)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    ctx.session = ctx.session || {};
    ctx.session.adminState = `waiting_bulk_qty_${productId}`;
    ctx.editMessageText('🔢 <b>Kural Ekle (Adım 1/3)</b>\n\nİndirim uygulanması için sepette <b>en az kaç adet</b> bu üründen olmalı?\n(Sadece sayı girin, örn: 50):', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: `admin_prod_bulk_${productId}` }]] }
    }).catch(e => {});
  });

  bot.action(/^admin_bulk_type_(\d+)_(\d+)_(percent|fixed)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    const minQty = parseInt(ctx.match[2], 10);
    const type = ctx.match[3];
    ctx.session = ctx.session || {};
    ctx.session.adminState = `waiting_bulk_val_${productId}_${minQty}_${type}`;
    ctx.editMessageText(`💰 <b>Kural Ekle (Adım 3/3)</b>\n\nEn az ${minQty} adet alındığında uygulanacak ${type === 'percent' ? 'Yüzde (%)' : 'Sabit Tutar ($)'} indirim <b>miktarı nedir?</b>\n(Sadece sayı girin, örn: 20):`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: `admin_prod_bulk_${productId}` }]] }
    }).catch(e => {});
  });

  bot.action('admin_back_main', adminMiddleware, (ctx) => {
    if (ctx.session) ctx.session.adminState = null;
    showAdminMenu(ctx, true);
  });

  bot.action(/^admin_sel_stock_(\d+)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);

    if (!product) {
      return ctx.answerCbQuery('Ürün bulunamadı!', { show_alert: true });
    }

    ctx.session = ctx.session || {};
    ctx.session.adminState = 'waiting_stock_data';
    ctx.session.stockProductId = productId;

    ctx.editMessageText(`✅ <b>${product.name}</b> ürünü seçildi.\n\nLütfen stoğu gönderin.\n\n<b>1. Yöntem:</b> Direkt mesaj olarak hesapları alt alta yazıp gönderebilirsiniz.\n<b>2. Yöntem:</b> İçerisinde alt alta hesaplar yazan bir <b>.txt</b> dosyasını buraya yükleyebilirsiniz.`, { 
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '❌ İptal', callback_data: 'admin_cancel' }]]
      }
    });
  });

  bot.action('admin_pricing_groups_menu', adminMiddleware, (ctx) => {
    ctx.editMessageText('🏢 <b>Fiyatlandırma Grupları Yönetimi</b>\nLütfen bir işlem seçin:', {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📋 Grupları Listele', callback_data: 'admin_group_list' }],
          [{ text: '➕ Yeni Grup Ekle', callback_data: 'admin_group_add' }],
          [{ text: '👤 Gruba Kullanıcı Ekle', callback_data: 'admin_group_adduser' }],
          [{ text: '🏷️ Gruba Özel Ürün Fiyatı', callback_data: 'admin_group_setprice' }],
          [{ text: '🔙 Geri Dön', callback_data: 'admin_back_main' }]
        ]
      }
    });
  });



  // API menu handlers are in admin_api.js
  setupAdminApiHandlers(bot, adminMiddleware);
  require('./admin_suppliers2')(bot, adminMiddleware);
  require('./admin_catalogpicker')(bot, adminMiddleware);

  bot.action(/^admin_api_autobuy(?:_(\d+))?$/, adminMiddleware, (ctx) => {
    const page = parseInt(ctx.match[1] || '1', 10);
    const limit = 5;
    const offset = (page - 1) * limit;
    const totalCount = db.prepare('SELECT COUNT(*) as count FROM products').get().count;
    const products = db.prepare('SELECT * FROM products WHERE is_active = 1 LIMIT ? OFFSET ?').all(limit, offset);
    
    const buttons = products.map(p => {
      let name = p.name;
      try {
        const parsed = JSON.parse(name);
        name = parsed['tr'] || parsed['en'] || name;
      } catch (e) {}
      return [{ text: name, callback_data: `admin_autobuy_prod_${p.id}` }];
    });

    const navButtons = [];
    if (page > 1) navButtons.push({ text: '⬅️ Önceki', callback_data: `admin_api_autobuy_${page - 1}` });
    if (offset + limit < totalCount) navButtons.push({ text: 'Sonraki ➡️', callback_data: `admin_api_autobuy_${page + 1}` });
    
    if (navButtons.length > 0) buttons.push(navButtons);
    buttons.push([{ text: '🔙 Geri Dön', callback_data: 'admin_api_menu' }]);

    ctx.editMessageText(`🤖 <b>Otomatik Alımı Düzenle (Sayfa ${page})</b>\nLütfen işlem yapmak istediğiniz ürünü seçin:`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: buttons
      }
    }).catch(e => {});
  });

  bot.action(/^admin_autobuy_prod_(\d+)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) return ctx.answerCbQuery('Ürün bulunamadı!', { show_alert: true });
    
    const status = product.auto_restock_enabled ? "✅ AÇIK" : "❌ KAPALI";

    ctx.editMessageText(`🤖 <b>Ürün:</b> ${product.name}\n<b>Mevcut Durum:</b> ${status}\n\nLütfen bu ürün için otomatik alımı açmak veya kapatmak istediğinizi seçin:`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Açık', callback_data: `admin_autobuy_status_${productId}_1` }, { text: '❌ Kapalı', callback_data: `admin_autobuy_status_${productId}_0` }],
          [{ text: '🔙 Ürünlere Dön', callback_data: 'admin_api_autobuy' }]
        ]
      }
    });
  });

  bot.action(/^admin_autobuy_status_(\d+)_([01])$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    const enabled = parseInt(ctx.match[2], 10);
    
    if (enabled === 0) {
      db.prepare('UPDATE products SET auto_restock_enabled = 0 WHERE id = ?').run(productId);
      ctx.editMessageText(`✅ Ürün ${productId} için otomatik alım <b>KAPATILDI</b>.`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Menüye Dön', callback_data: 'admin_api_autobuy' }]] }});
    } else {
      ctx.session = ctx.session || {};
      ctx.session.adminState = 'waiting_autobuy_threshold';
      ctx.session.autobuyProductId = productId;
      
      ctx.editMessageText(`✅ <b>Otomatik alım AÇILACAK.</b>\n\nLütfen tetiklenme sınırını yazın (Sadece sayı giriniz).\n<i>Örnek: Eğer stok 2'nin altına düşünce alım yapılsın istiyorsanız 2 yazın:</i>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: 'admin_cancel' }]] }});
    }
  });

  bot.action(/^admin_group_list(?:_(\d+))?$/, adminMiddleware, (ctx) => {
    const page = parseInt(ctx.match[1] || 1, 10);
    const limit = 10;
    const offset = (page - 1) * limit;

    const totalCount = db.prepare('SELECT COUNT(*) as count FROM pricing_groups').get().count;
    if (totalCount === 0) return ctx.answerCbQuery('Henüz grup yok!', { show_alert: true });

    const groups = db.prepare('SELECT * FROM pricing_groups LIMIT ? OFFSET ?').all(limit, offset);
    
    let msg = `<b>Fiyatlandırma Grupları (Sayfa ${page}):</b>\n\n`;
    groups.forEach(g => { msg += `ID: <b>${g.id}</b> | İsim: ${g.name} | İndirim: ${g.discount_percent}%\n`; });
    
    const inline_keyboard = [];
    const navButtons = [];
    if (page > 1) navButtons.push({ text: '⬅️ Önceki', callback_data: `admin_group_list_${page - 1}` });
    if (offset + limit < totalCount) navButtons.push({ text: 'Sonraki ➡️', callback_data: `admin_group_list_${page + 1}` });
    
    if (navButtons.length > 0) inline_keyboard.push(navButtons);
    inline_keyboard.push([{ text: '🔙 Geri Dön', callback_data: 'admin_pricing_groups_menu' }]);

    ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard } }).catch(e => {});
  });

  bot.action('admin_group_add', adminMiddleware, (ctx) => {
    ctx.session = ctx.session || {}; ctx.session.adminState = 'waiting_group_add';
    ctx.editMessageText('➕ <b>Yeni Grup Ekle</b>\nLütfen grubun adını ve varsayılan indirim yüzdesini aralarında boşluk bırakarak yazın (Örn: VIP 15):', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: 'admin_cancel' }]] }});
  });

  bot.action('admin_group_adduser', adminMiddleware, (ctx) => {
    ctx.session = ctx.session || {}; ctx.session.adminState = 'waiting_group_adduser';
    ctx.editMessageText('👤 <b>Gruba Kullanıcı Ekle</b>\nLütfen kullanıcı ID\'sini ve Grup ID\'sini aralarında boşluk bırakarak yazın (Örn: 123456789 2):', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: 'admin_cancel' }]] }});
  });

  bot.action('admin_group_setprice', adminMiddleware, (ctx) => {
    ctx.session = ctx.session || {}; ctx.session.adminState = 'waiting_group_setprice';
    ctx.editMessageText('🏷️ <b>Gruba Özel Fiyat Belirle</b>\nLütfen Grup ID, Ürün ID ve Özel Fiyatı aralarında boşluk bırakarak yazın (Örn: 2 1 5.5):', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: 'admin_cancel' }]] }});
  });


  bot.action('admin_stats_menu', adminMiddleware, async (ctx) => {
    ctx.answerCbQuery('Grafik ve kurlar çekiliyor, lütfen bekleyin...').catch(()=>null);
    try { await ctx.deleteMessage(); } catch (e) {}

    const { getUsdTryRate } = require('../utils/currency');
    const tryRate = await getUsdTryRate();
    
    const allOrders = db.prepare("SELECT * FROM orders WHERE status IS NULL OR status != 'cancelled'").all();
    
    let total = { income: 0, expense: 0, profit: 0, income_t: 0, expense_t: 0, profit_t: 0 };
    let daily = { income: 0, expense: 0, profit: 0, income_t: 0, expense_t: 0, profit_t: 0 };
    let monthly = { income: 0, expense: 0, profit: 0, income_t: 0, expense_t: 0, profit_t: 0 };
    
    const today = new Date();
    
    allOrders.forEach(o => {
       const profit = parseFloat(o.profit_usd || 0);
       const income = parseFloat(o.sell_usd || 0);
       const expense = parseFloat(o.cost_usd || 0);
       
       const profit_t = parseFloat(o.profit_try || (profit * tryRate));
       const income_t = parseFloat(o.sell_try || (income * tryRate));
       const expense_t = parseFloat(o.cost_try || (expense * tryRate));
       
       total.profit += profit;
       total.income += income;
       total.expense += expense;
       total.profit_t += profit_t;
       total.income_t += income_t;
       total.expense_t += expense_t;
       
       const dt = o.created_at ? new Date(o.created_at + 'Z') : new Date();
       if (dt.toDateString() === today.toDateString()) {
         daily.profit += profit;
         daily.income += income;
         daily.expense += expense;
         daily.profit_t += profit_t;
         daily.income_t += income_t;
         daily.expense_t += expense_t;
       }
       if (dt.getMonth() === today.getMonth() && dt.getFullYear() === today.getFullYear()) {
         monthly.profit += profit;
         monthly.income += income;
         monthly.expense += expense;
         monthly.profit_t += profit_t;
         monthly.income_t += income_t;
         monthly.expense_t += expense_t;
       }
    });

    const { generateStatsChart } = require('../utils/canvas');
    const imageBuffer = await generateStatsChart(daily, monthly, total);

    const axios = require('axios');
    const FormData = require('form-data');
    const { BOT_TOKEN } = require('../config/env');
    
    const d = {
      i: { u: daily.income.toFixed(2), t: daily.income_t.toFixed(2) },
      e: { u: daily.expense.toFixed(2), t: daily.expense_t.toFixed(2) },
      p: { u: daily.profit.toFixed(2), t: daily.profit_t.toFixed(2) }
    };
    const m = {
      i: { u: monthly.income.toFixed(2), t: monthly.income_t.toFixed(2) },
      e: { u: monthly.expense.toFixed(2), t: monthly.expense_t.toFixed(2) },
      p: { u: monthly.profit.toFixed(2), t: monthly.profit_t.toFixed(2) }
    };
    const t_s = {
      i: { u: total.income.toFixed(2), t: total.income_t.toFixed(2) },
      e: { u: total.expense.toFixed(2), t: total.expense_t.toFixed(2) },
      p: { u: total.profit.toFixed(2), t: total.profit_t.toFixed(2) }
    };

    let caption = `📊 <b>GELİŞMİŞ KAZANÇ İSTATİSTİKLERİ</b>\n\n`;
    caption += `⏱ <b>Günlük İstatistikler</b>\n`;
    caption += `🟢 Gelir: <b>${d.i.u}$</b> | ${d.i.t}₺\n`;
    caption += `🔴 Gider: <b>${d.e.u}$</b> | ${d.e.t}₺\n`;
    caption += `🔵 Net Kâr: <b>${d.p.u}$</b> | ${d.p.t}₺\n\n`;
    
    caption += `📅 <b>Aylık İstatistikler</b>\n`;
    caption += `🟢 Gelir: <b>${m.i.u}$</b> | ${m.i.t}₺\n`;
    caption += `🔴 Gider: <b>${m.e.u}$</b> | ${m.e.t}₺\n`;
    caption += `🔵 Net Kâr: <b>${m.p.u}$</b> | ${m.p.t}₺\n\n`;
    
    caption += `🌍 <b>Toplam İstatistikler</b>\n`;
    caption += `🟢 Gelir: <b>${t_s.i.u}$</b> | ${t_s.i.t}₺\n`;
    caption += `🔴 Gider: <b>${t_s.e.u}$</b> | ${t_s.e.t}₺\n`;
    caption += `🔵 Net Kâr: <b>${t_s.p.u}$</b> | ${t_s.p.t}₺\n\n`;
    
    caption += `<i>💡 Anlık Kur: 1 USD = ${tryRate.toFixed(2)} TRY</i>`;

    const form = new FormData();
    form.append('chat_id', ctx.from.id);
    form.append('photo', imageBuffer, { filename: 'stats.png', contentType: 'image/png' });
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('reply_markup', JSON.stringify({
      inline_keyboard: [[{ text: '🔙 Geri Dön', callback_data: 'admin_back_main' }]]
    }));

    try {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, form, {
        headers: form.getHeaders()
      });
    } catch (err) {
      console.error('Error sending admin stats:', err.message);
      ctx.reply('❌ Resim gönderilirken bir hata oluştu: ' + err.message);
    }
  });

  // Bir kullanıcıyı yazılı girdiden çözümle: sayısal ID veya @kullanıcıadı.
  // (Telefon numarası tabloda tutulmadığı için desteklenmez.)
  function resolveUserToken(raw) {
    const s = String(raw || '').trim().replace(/^@/, '');
    if (/^\d{1,20}$/.test(s)) {
      const id = parseInt(s, 10);
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (u) return { ok: true, user: u, via: 'ID' };
      return { ok: false, error: `ID <code>${id}</code> ile kayıtlı kullanıcı yok — kişi önce botu başlatmış olmalı (veya mesajını ileterek ID'yi otomatik alın).`, suggestId: id };
    }
    if (/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s)) {
      const u = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(s);
      if (u) return { ok: true, user: u, via: '@' + s };
      return { ok: false, error: `<b>@${s}</b> ile kayıtlı kullanıcı yok. Kişi botu hiç başlatmamış olabilir — bir mesajını buraya <b>iletin</b>, ID'sini otomatik alayım.` };
    }
    return { ok: false, error: 'Geçerli bir <b>User ID</b> veya <b>@kullanıcıadı</b> yazın.' };
  }

  // İletilen mesajdan asıl göndereni çıkarır (Bot API 7.2 forward_origin; eski
  // istemcilerden gelen forward_from yedeğiyle).
  function forwardedUser(ctx) {
    const m = ctx.message || {};
    const org = m.forward_origin;
    if (org && org.type === 'user' && (org.sender_user_id || org.sender_user?.id)) {
      const su = org.sender_user || {};
      return { id: org.sender_user_id || su.id, username: org.sender_user_name || su.username || null, first_name: su.first_name || org.author_signature || null };
    }
    if (m.forward_from) {
      return { id: m.forward_from.id, username: m.forward_from.username || null, first_name: m.forward_from.first_name || null };
    }
    return null;
  }

  // Kullanıcı satırını garanti eder (iletilen mesajdan gelenler için).
  function ensureUserRow(fu) {
    db.prepare('INSERT OR IGNORE INTO users (id, username, first_name) VALUES (?, ?, ?)').run(fu.id, fu.username, fu.first_name);
    if (fu.username) {
      db.prepare("UPDATE users SET username = ? WHERE id = ? AND (username IS NULL OR username = '')").run(fu.username, fu.id);
    }
  }

  bot.action('admin_balance_menu', adminMiddleware, (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.adminState = 'waiting_balance_user_id';
    ctx.editMessageText(
      '💼 <b>Bakiye Yönetimi</b>\nKullanıcıyı belirtin — üç yoldan biri:\n' +
      '• <code>123456789</code> (User ID)\n' +
      '• <code>@kullanıcıadı</code>\n' +
      '• Kişinin herhangi bir mesajını <b>buraya iletin</b> (ID otomatik alınır) 💉',
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: 'admin_cancel' }]] }
      }
    ).catch(e => {});
  });

  bot.action('admin_promo_menu', adminMiddleware, (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.adminState = 'waiting_promo_code_name';
    ctx.editMessageText('🎟 <b>Promo Kod Yönetimi</b>\nYeni promo kodun ismini girin (Örn: YAZ2026):', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: 'admin_cancel' }]] }
    }).catch(e => {});
  });

  bot.action('admin_rank_menu', adminMiddleware, (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.adminState = 'waiting_rank_name';
    ctx.editMessageText('🏆 <b>Rank Ekleme</b>\nYeni Rank ismini yazın (Örn: Elite VIP):', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: 'admin_cancel' }]] }
    }).catch(e => {});
  });

  bot.action('admin_reseller_menu', adminMiddleware, (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.adminState = 'waiting_reseller_user_id';
    ctx.editMessageText('🤝 <b>Bayi Ekleme</b>\nBayi yapılacak kişinin <b>User ID</b>\'sini girin:', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: 'admin_cancel' }]] }
    }).catch(e => {});
  });

  // --- SON SİPARİŞLER & REZERVASYONLAR ---
  bot.action('admin_recent_orders_menu', adminMiddleware, (ctx) => {
    ctx.editMessageText('📝 <b>Son Siparişler ve Rezervasyonlar</b>\nLütfen görüntülemek istediğiniz listeyi seçin:', {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🟢 Tamamlanmış Siparişler', callback_data: 'admin_recent_completed_1' }],
          [{ text: '⏳ Bekleyen Rezervasyonlar', callback_data: 'admin_recent_pending_1' }],
          [{ text: '🔙 Ana Menü', callback_data: 'admin_back_main' }]
        ]
      }
    }).catch(e => {});
  });

  // Tamamlanmış Siparişler (orders tablosu)
  bot.action(/^admin_recent_completed_(\d+)$/, adminMiddleware, (ctx) => {
    const page = parseInt(ctx.match[1] || 1, 10);
    const limit = 10;
    const offset = (page - 1) * limit;

    const totalCount = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status IS NULL OR status != 'cancelled'").get().count;
    if (totalCount === 0) return ctx.answerCbQuery('Hiç sipariş bulunamadı.', { show_alert: true });

    const orders = db.prepare("SELECT o.*, u.username, p.name as product_name FROM orders o LEFT JOIN users u ON o.user_id = u.id LEFT JOIN products p ON o.product_id = p.id WHERE o.status IS NULL OR o.status != 'cancelled' ORDER BY o.id DESC LIMIT ? OFFSET ?").all(limit, offset);
    
    const buttons = orders.map(o => {
      let pName = o.product_name || 'Bilinmiyor';
      try { const parsed = JSON.parse(pName); pName = parsed['tr'] || parsed['en'] || pName; } catch (e) {}
      return [{ text: `Sip #${o.id} | @${o.username || o.user_id} | ${pName.substring(0, 15)}`, callback_data: `admin_order_detail_${o.id}` }];
    });

    const navButtons = [];
    if (page > 1) navButtons.push({ text: '⬅️ Önceki', callback_data: `admin_recent_completed_${page - 1}` });
    if (offset + limit < totalCount) navButtons.push({ text: 'Sonraki ➡️', callback_data: `admin_recent_completed_${page + 1}` });
    if (navButtons.length > 0) buttons.push(navButtons);
    
    buttons.push([{ text: '🔙 Menüye Dön', callback_data: 'admin_recent_orders_menu' }]);

    ctx.editMessageText(`🟢 <b>Tamamlanmış Siparişler (Sayfa ${page})</b>\nDetayını görmek istediğiniz siparişe tıklayın:`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }).catch(e => {});
  });

  /**
   * Recompute the derived money columns of an order after an admin edit.
   * Rates are taken from the existing row so a historic order keeps its own
   * USD->TRY conversion instead of silently re-rating at today's rate.
   */
  function recalcOrder(order) {
    const qty = order.qty || 1;
    const sell = parseFloat(order.sell_usd) || 0;
    const cost = parseFloat(order.cost_usd) || 0;
    const profit = sell - cost * qty;

    const sellTry = parseFloat(order.sell_try);
    const rateFromSell = sell > 0 && Number.isFinite(sellTry) && sellTry > 0 ? sellTry / sell : null;
    const rate = rateFromSell || 47.22;

    return {
      profit_usd: profit,
      profit_try: profit * rate,
      cost_usd: cost,
      cost_try: cost * qty * rate,
      sell_usd: sell,
      sell_try: sell * rate
    };
  }

  function orderDetailText(order, pName) {
    const qty = order.qty || 1;
    const sell = parseFloat(order.sell_usd) || 0;
    const cost = parseFloat(order.cost_usd) || 0;
    const profit = parseFloat(order.profit_usd != null ? order.profit_usd : sell - cost * qty);
    const margin = cost > 0 ? ((sell - cost * qty) / (cost * qty)) * 100 : null;
    const statusLine = order.status === 'cancelled' ? '\n🚫 <b>İPTAL EDİLDİ</b>' : '';
    const editLine = order.edited_at
      ? `\n✏️ Son düzenleme: ${order.edited_at}${order.edit_note ? ` — ${order.edit_note}` : ''}`
      : '';

    return `🟢 <b>Sipariş Detayı (#${order.id})</b>${statusLine}\n\n` +
      `👤 Kullanıcı: @${order.username || order.user_id} (ID: ${order.user_id})\n` +
      `📦 Ürün: ${pName}\n` +
      `🔢 Adet: <b>${qty}</b>\n\n` +
      `💵 Tahsil edilen: <b>${sell.toFixed(2)} USD</b>\n` +
      `🧾 Maliyet: <b>${cost.toFixed(2)} USD</b> (adet başı ${(cost / (qty || 1)).toFixed(4)})\n` +
      `💰 Kâr: <b>${profit.toFixed(2)} USD</b>${margin !== null ? ` (%${margin.toFixed(0)})` : ''}\n` +
      `📅 Tarih: ${order.created_at}` +
      (order.supplier_id ? `\n🏭 Kaynak: supplier #${order.supplier_id}${order.remote_service_id ? ` / ${order.remote_service_id}` : ''}` : '') +
      editLine;
  }

  bot.action(/^admin_order_detail_(\d+)$/, adminMiddleware, (ctx) => {
    const orderId = parseInt(ctx.match[1], 10);
    const order = db.prepare('SELECT o.*, u.username, p.name as product_name FROM orders o LEFT JOIN users u ON o.user_id = u.id LEFT JOIN products p ON o.product_id = p.id WHERE o.id = ?').get(orderId);

    if (!order) return ctx.answerCbQuery('Sipariş bulunamadı.', { show_alert: true });

    let pName = order.product_name || 'Bilinmiyor';
    try { const parsed = JSON.parse(pName); pName = parsed['tr'] || parsed['en'] || pName; } catch (e) {}

    ctx.editMessageText(orderDetailText(order, pName), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✏️ Geliri (Ödenen) Düzenle', callback_data: `admin_order_edit_${order.id}_sell` }],
          [{ text: '✏️ Maliyeti Düzenle', callback_data: `admin_order_edit_${order.id}_cost` }],
          [{ text: '✏️ Kazancı (Kâr) Düzenle', callback_data: `admin_order_edit_${order.id}_profit` }],
          [{ text: '❌ İptal Et (Ücret İadesi Yap)', callback_data: `admin_order_cancel_${order.id}_yes` }],
          [{ text: '❌ İptal Et (İade Yapma)', callback_data: `admin_order_cancel_${order.id}_no` }],
          [{ text: '🔙 Listeye Dön', callback_data: 'admin_recent_completed_1' }]
        ]
      }
    }).catch(e => {});
  });

  const ORDER_EDIT_PROMPT = {
    sell: '💵 <b>Gelir düzenleme</b>\nMüşterinin ödediği <b>toplam USD</b> tutarını girin (Örn: 74,45):\n<i>Kâr, yeni gelire göre yeniden hesaplanır.</i>',
    cost: '🧾 <b>Maliyet düzenleme</b>\nBu siparişin <b>toplam</b> tedarikçi maliyetini USD girin (Örn: 2,90):\n<i>Kâr, yeni maliyete göre yeniden hesaplanır.</i>',
    profit: '💰 <b>Kâr düzenleme</b>\nDoğrudan <b>kâr USD</b> girin (Örn: 45,50):\n<i>Gelir, maliyet + bu kâr olacak şekilde ayarlanır.</i>'
  };

  bot.action(/^admin_order_edit_(\d+)_(sell|cost|profit)$/, adminMiddleware, (ctx) => {
    const orderId = parseInt(ctx.match[1], 10);
    const field = ctx.match[2];
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return ctx.answerCbQuery('Sipariş bulunamadı.', { show_alert: true });

    ctx.session = ctx.session || {};
    ctx.session.adminState = `waiting_order_edit_${orderId}_${field}`;
    ctx.editMessageText(
      `${ORDER_EDIT_PROMPT[field]}\n\n<b>Sipariş #${orderId}</b> — mevcut: gelir ${order.sell_usd}$ / maliyet ${order.cost_usd}$ / kâr ${order.profit_usd}$`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: `admin_order_detail_${orderId}` }]] } }
    ).catch(e => {});
  });

  bot.action(/^admin_order_cancel_(\d+)_([a-z]+)$/, adminMiddleware, (ctx) => {
    const orderId = parseInt(ctx.match[1], 10);
    const refund = ctx.match[2] === 'yes';

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return ctx.answerCbQuery('Sipariş bulunamadı.', { show_alert: true });

    if (order.status === 'cancelled') {
      return ctx.answerCbQuery('Bu sipariş zaten iptal edilmiş.', { show_alert: true });
    }

    if (refund) {
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(order.sell_usd, order.user_id);
    }

    // Soft cancel: keep the row for auditing (idempotent status column).
    db.prepare("UPDATE orders SET status = 'cancelled', edited_at = CURRENT_TIMESTAMP, edited_by = ?, edit_note = ? WHERE id = ?")
      .run(ctx.from.id, refund ? 'iptal + iade' : 'iptal (iade yok)', orderId);

    // Return the delivered stock to the pool so it can be sold again.
    let returned = 0;
    try {
      const delivered = order.delivered_data ? JSON.parse(order.delivered_data) : [];
      if (Array.isArray(delivered) && delivered.length) {
        const ids = db.prepare('SELECT id FROM stocks WHERE product_id = ? AND is_sold = 1 ORDER BY id DESC LIMIT ?')
          .all(order.product_id, delivered.length)
          .map((r) => r.id);
        if (ids.length) {
          const back = db.prepare('UPDATE stocks SET is_sold = 0 WHERE id = ?');
          db.transaction(() => ids.forEach((id) => back.run(id)))();
          returned = ids.length;
        }
      }
    } catch (e) {
      console.error('order cancel restock failed:', e.message);
    }

    const msg = `${refund
      ? `✅ Sipariş #${orderId} iptal edildi, <b>${order.sell_usd} USD</b> kullanıcıya (ID: ${order.user_id}) iade edildi.`
      : `✅ Sipariş #${orderId} iptal edildi. (İade yapılmadı)`}${returned ? `\n📦 ${returned} adet stok yeniden satışa alındı.` : ''}\nℹ️ Kayıt silinmedi, "İptal" olarak işaretlendi.`;

    ctx.answerCbQuery('İşlem başarılı.').catch(() => null);
    ctx.editMessageText(msg, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Listeye Dön', callback_data: 'admin_recent_completed_1' }]] }
    }).catch(e => {});
  });

  // Bekleyen Rezervasyonlar (reservations tablosu status='PENDING')
  bot.action(/^admin_recent_pending_(\d+)$/, adminMiddleware, (ctx) => {
    const page = parseInt(ctx.match[1] || 1, 10);
    const limit = 10;
    const offset = (page - 1) * limit;

    const totalCount = db.prepare("SELECT COUNT(*) as count FROM reservations WHERE status = 'PENDING'").get().count;
    if (totalCount === 0) return ctx.answerCbQuery('Hiç bekleyen rezervasyon bulunamadı.', { show_alert: true });

    const reservations = db.prepare("SELECT r.*, u.username, p.name as product_name FROM reservations r LEFT JOIN users u ON r.user_id = u.id LEFT JOIN products p ON r.product_id = p.id WHERE r.status = 'PENDING' ORDER BY r.id DESC LIMIT ? OFFSET ?").all(limit, offset);
    
    const buttons = reservations.map(r => {
      let pName = r.product_name || 'Bilinmiyor';
      try { const parsed = JSON.parse(pName); pName = parsed['tr'] || parsed['en'] || pName; } catch (e) {}
      return [{ text: `Rez #${r.id} | @${r.username || r.user_id} | ${pName.substring(0, 15)}`, callback_data: `admin_res_detail_${r.id}` }];
    });

    const navButtons = [];
    if (page > 1) navButtons.push({ text: '⬅️ Önceki', callback_data: `admin_recent_pending_${page - 1}` });
    if (offset + limit < totalCount) navButtons.push({ text: 'Sonraki ➡️', callback_data: `admin_recent_pending_${page + 1}` });
    if (navButtons.length > 0) buttons.push(navButtons);
    
    buttons.push([{ text: '🔙 Menüye Dön', callback_data: 'admin_recent_orders_menu' }]);

    ctx.editMessageText(`⏳ <b>Bekleyen Rezervasyonlar (Sayfa ${page})</b>\nDetayını görmek istediğiniz işlemi seçin:`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }).catch(e => {});
  });

  bot.action(/^admin_res_detail_(\d+)$/, adminMiddleware, (ctx) => {
    const resId = parseInt(ctx.match[1], 10);
    const r = db.prepare('SELECT r.*, u.username, p.name as product_name FROM reservations r LEFT JOIN users u ON r.user_id = u.id LEFT JOIN products p ON r.product_id = p.id WHERE r.id = ?').get(resId);
    
    if (!r) return ctx.answerCbQuery('Rezervasyon bulunamadı.', { show_alert: true });

    let pName = r.product_name || 'Bilinmiyor';
    try { const parsed = JSON.parse(pName); pName = parsed['tr'] || parsed['en'] || pName; } catch (e) {}

    const text = `⏳ <b>Rezervasyon Detayı (#${r.id})</b>\n\n👤 Kullanıcı: @${r.username || r.user_id} (ID: ${r.user_id})\n📦 Ürün: ${pName}\n🔢 Kalan Bekleyen Adet: ${r.qty - r.fulfilled_qty}\n💵 Toplam Ödenen: ${r.sell_usd} USD\n📅 Tarih: ${r.created_at}\nDurum: ${r.status}`;

    ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ İptal Et (Ücret İadesi Yap)', callback_data: `admin_res_cancel_${r.id}_yes` }],
          [{ text: '❌ İptal Et (İade Yapma)', callback_data: `admin_res_cancel_${r.id}_no` }],
          [{ text: '🔙 Listeye Dön', callback_data: 'admin_recent_pending_1' }]
        ]
      }
    }).catch(e => {});
  });

  bot.action(/^admin_res_cancel_(\d+)_([a-z]+)$/, adminMiddleware, (ctx) => {
    const resId = parseInt(ctx.match[1], 10);
    const refund = ctx.match[2] === 'yes';

    const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(resId);
    if (!r) return ctx.answerCbQuery('Rezervasyon bulunamadı.', { show_alert: true });

    if (r.status !== 'PENDING') return ctx.answerCbQuery('Bu işlem artık beklemede değil.', { show_alert: true });

    // Calculate how much was paid for the *unfulfilled* part of the reservation
    const remainingQty = r.qty - r.fulfilled_qty;
    const unitPrice = r.unit_price || (r.qty > 0 ? (r.sell_usd / r.qty) : 0);
    const refundAmount = remainingQty * unitPrice;

    if (refund && refundAmount > 0) {
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(refundAmount, r.user_id);
    }
    
    db.prepare("UPDATE reservations SET status = 'CANCELLED' WHERE id = ?").run(resId);

    const msg = refund ? `✅ Rezervasyon iptal edildi ve kalan adet tutarı (<b>${refundAmount.toFixed(2)} USD</b>) bakiye olarak iade edildi.` : `✅ Rezervasyon iptal edildi. (İade yapılmadı)`;
    
    ctx.answerCbQuery('İşlem başarılı.').catch(()=>null);
    ctx.editMessageText(msg, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Listeye Dön', callback_data: 'admin_recent_pending_1' }]] }
    }).catch(e => {});
  });

  // Metin veya Belge Dinleyicisi
  bot.on('message', async (ctx, next) => {
    if (ctx.from.id !== ADMIN_ID) return next();
    if (!ctx.session || !ctx.session.adminState) return next();
    const state = ctx.session.adminState;
    const lang = getUserLang(ctx.from.id);

    // --- Ürün Ekleme: İsim Bekleniyor ---
    if (state === 'waiting_product_name') {
      if (!ctx.message.text) return ctx.reply('❌ Lütfen sadece metin gönderin.');
      
      ctx.session.newProductName = ctx.message.text;
      ctx.session.adminState = 'waiting_product_price';

      ctx.reply(`✅ Ürün İsmi: <b>${ctx.session.newProductName}</b>\n\nŞimdi lütfen ürünün <b>fiyatını</b> (USD cinsinden, sadece sayı) gönderin:`, { parse_mode: 'HTML' });
    } 
    
    // --- Ürün Ekleme: Fiyat Bekleniyor ---
    else if (state === 'waiting_product_price') {
      if (!ctx.message.text) return ctx.reply('❌ Lütfen sadece sayı gönderin.');
      
      const price = parseMoney(ctx.message.text);
      if (price === null || price <= 0) {
        return ctx.reply('❌ Lütfen geçerli bir fiyat girin (Örn: 15 veya 10.5)');
      }

      ctx.session.newProductPrice = price;
      ctx.session.adminState = 'waiting_product_cost';

      ctx.reply(`✅ Satış Fiyatı: <b>${price} USD</b>\n\nŞimdi lütfen bu ürünün <b>Birim Maliyetini (USD)</b> girin (Örn: 0.5 veya 1.25).\nEğer maliyet yoksa 0 yazabilirsiniz:`, { parse_mode: 'HTML' });
    }

    // --- Ürün Ekleme: Maliyet Bekleniyor ---
    else if (state === 'waiting_product_cost') {
      if (!ctx.message.text) return ctx.reply('❌ Lütfen sadece sayı gönderin.');
      
      const costUsd = parseMoney(ctx.message.text);
      if (costUsd === null || costUsd < 0) {
        return ctx.reply('❌ Lütfen geçerli bir maliyet girin (Örn: 0.50).');
      }

      const baseName = ctx.session.newProductName;
      const price = ctx.session.newProductPrice;

      try {
        const info = db.prepare('INSERT INTO products (name, price, cost_usd) VALUES (?, ?, ?)').run(baseName, price, costUsd);
        ctx.reply(`🎉 <b>Ürün Başarıyla Oluşturuldu!</b>\n\nID: <b>${info.lastInsertRowid}</b>\nİsim: ${baseName}\nFiyat: ${price}$\nMaliyet: ${costUsd}$`, { 
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Ürün Yönetimine Dön', callback_data: 'admin_products_menu' }]] }
        });
        
        // İşlemi temizle
        ctx.session.adminState = null;
        ctx.session.newProductName = null;
        ctx.session.newProductPrice = null;
      } catch (err) {
        console.error(err);
        ctx.reply('❌ Veritabanına kaydedilirken bir hata oluştu.');
      }
    }
    else if (state && state.startsWith('waiting_price_increase_')) {
      const productId = parseInt(state.split('_')[3], 10);
      const percentageStr = ctx.message.text.trim();
      const percentage = parseMoney(percentageStr);

      if (percentage === null) {
        return ctx.reply('Lütfen geçerli bir sayı girin (Örn: 20 veya -10):');
      }

      const multiplier = 1 + (percentage / 100);

      try {
        const updateProduct = db.prepare('UPDATE products SET price = ROUND(price * ?, 2) WHERE id = ?');
        const updateBulk = db.prepare('UPDATE product_bulk_discounts SET fixed_price = ROUND(fixed_price * ?, 2) WHERE product_id = ? AND fixed_price IS NOT NULL');
        const updateGroups = db.prepare('UPDATE pricing_group_products SET price = ROUND(price * ?, 2) WHERE product_id = ?');
        const updateRanks = db.prepare('UPDATE rank_special_prices SET special_price = ROUND(special_price * ?, 2) WHERE product_id = ?');

        const applyUpdates = db.transaction(() => {
          updateProduct.run(multiplier, productId);
          updateBulk.run(multiplier, productId);
          updateGroups.run(multiplier, productId);
          updateRanks.run(multiplier, productId);
        });

        applyUpdates();
        ctx.session.adminState = null;
        ctx.reply(`Başarılı! Ürün ana fiyatı ve bağlı olduğu tüm toplu, grup, rütbe fiyatlarına %${percentage} değişiklik uygulandı.`, {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Ürüne Dön', callback_data: `admin_product_detail_${productId}` }]] }
        });
      } catch (e) {
        console.error('Error applying bulk price increase:', e);
        ctx.reply('❌ Zam işlemi sırasında bir hata oluştu.');
      }
    }
    else if (state && state.startsWith('waiting_edit_name_')) {
      const productId = parseInt(state.split('_')[3], 10);
      const name = ctx.message.text.trim();
      if (!name) return ctx.reply('❌ Geçerli bir isim girin.');
      
      db.prepare('UPDATE products SET name = ? WHERE id = ?').run(name, productId);
      ctx.session.adminState = null;
      ctx.reply(`✅ Ürün ismi başarıyla güncellendi!\n\nYeni İsim: ${name}`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Ürüne Dön', callback_data: `admin_product_detail_${productId}` }]] }
      });
    }
    else if (state && state.startsWith('waiting_edit_price_')) {
      const productId = parseInt(state.split('_')[3], 10);
      const price = parseMoney(ctx.message.text);
      if (price === null || price <= 0) return ctx.reply('❌ Geçerli bir fiyat girin.');
      
      db.prepare('UPDATE products SET price = ? WHERE id = ?').run(price, productId);
      ctx.session.adminState = `waiting_edit_cost_${productId}`;
      ctx.reply(`✅ Satış fiyatı güncellendi!\n\nŞimdi lütfen yeni <b>Birim Maliyeti (USD)</b> girin (0 yazabilirsiniz):`, { parse_mode: 'HTML' });
    }
    else if (state && state.startsWith('waiting_edit_cost_')) {
      const productId = parseInt(state.split('_')[3], 10);
      const cost = parseMoney(ctx.message.text);
      if (cost === null || cost < 0) return ctx.reply('❌ Geçerli bir maliyet girin.');
      
      db.prepare('UPDATE products SET cost_usd = ? WHERE id = ?').run(cost, productId);
      ctx.session.adminState = null;
      ctx.reply(`✅ Ürün fiyat ve maliyet bilgileri başarıyla güncellendi!`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Ürüne Dön', callback_data: `admin_product_detail_${productId}` }]] }
      });
    }
    else if (state && state.startsWith('waiting_bulk_qty_')) {
      const productId = parseInt(state.split('_')[3], 10);
      const qty = require('../utils/money').parseQuantity(ctx.message.text);
      if (isNaN(qty) || qty <= 0) return ctx.reply('❌ Geçerli bir adet girin.');
      
      ctx.session.adminState = null;
      ctx.reply(`🔢 <b>Kural Ekle (Adım 2/3)</b>\n\n${qty} adet için uygulanacak indirim tipini seçin:`, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Yüzdelik İndirim (%)', callback_data: `admin_bulk_type_${productId}_${qty}_percent` },
              { text: 'Sabit İndirim ($)', callback_data: `admin_bulk_type_${productId}_${qty}_fixed` }
            ],
            [{ text: '❌ İptal', callback_data: `admin_prod_bulk_${productId}` }]
          ]
        }
      });
    }
    else if (state && state.startsWith('waiting_bulk_val_')) {
      const parts = state.split('_');
      const productId = parseInt(parts[3], 10);
      const minQty = parseInt(parts[4], 10);
      const type = parts[5];
      
      const val = parseMoney(ctx.message.text);
      if (val === null || val <= 0) return ctx.reply('❌ Geçerli bir miktar girin.');
      
      if (type === 'percent') {
        db.prepare('INSERT INTO product_bulk_discounts (product_id, min_qty, discount_percent, fixed_price) VALUES (?, ?, ?, NULL)').run(productId, minQty, val);
      } else {
        db.prepare('INSERT INTO product_bulk_discounts (product_id, min_qty, discount_percent, fixed_price) VALUES (?, ?, 0, ?)').run(productId, minQty, val);
      }
      ctx.session.adminState = null;
      ctx.reply(`✅ Başarılı! ${minQty} adet için ${type==='percent'?`%${val} indirim`:`$${val} sabit fiyat`} eklendi.`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Kurallara Dön', callback_data: `admin_prod_bulk_${productId}` }]] }
      });
    }

    // --- Stok Ekleme: Metin veya Belge Bekleniyor ---
    else if (state === 'waiting_stock_data') {
      const productId = ctx.session.stockProductId;
      let lines = [];

      // 1. Durum: Mesaj Olarak Gönderildiyse
      if (ctx.message.text) {
        lines = ctx.message.text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
      } 
      // 2. Durum: Dosya (.txt) Olarak Gönderildiyse
      else if (ctx.message.document) {
        const document = ctx.message.document;
        if (!document.file_name.endsWith('.txt')) {
          return ctx.reply('❌ Lütfen sadece .txt formatında bir dosya gönderin veya hesapları mesaj olarak atın.');
        }

        try {
          ctx.reply('⏳ Dosya okunuyor, lütfen bekleyin...');
          const fileUrl = await ctx.telegram.getFileLink(document.file_id);
          const response = await axios.get(fileUrl.href);
          const fileContent = response.data;
          lines = fileContent.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        } catch (err) {
          console.error(err);
          return ctx.reply('❌ Dosya işlenirken hata oluştu.');
        }
      } else {
        return ctx.reply('❌ Lütfen geçerli bir metin veya dosya gönderin.');
      }

      if (lines.length === 0) {
        return ctx.reply('❌ Gönderilen veri boş veya okunabilir değil.');
      }

      // Stokları Veritabanına Ekle
      try {
        const insertStock = db.prepare('INSERT INTO stocks (product_id, data) VALUES (?, ?)');
        const insertMany = db.transaction((linesData) => {
          for (const line of linesData) {
            insertStock.run(productId, line);
          }
        });

        insertMany(lines);

        const currentStockRow = db.prepare('SELECT COUNT(*) as count FROM stocks WHERE product_id = ? AND is_sold = 0').get(productId);
        const productRow = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
        if (currentStockRow && productRow) {
           sendRestockLog(ctx.telegram, productRow.name, lines.length, currentStockRow.count);
        }

        ctx.session.adminState = `waiting_stock_cost_${productId}`;
        ctx.session.stockProductId = null;

        ctx.reply(`✅ <b>Harika!</b> Ürüne tam <b>${lines.length}</b> adet yeni stok başarıyla eklendi!\n\nŞimdi lütfen bu stokların <b>Birim Maliyetini (USD)</b> girin (Örn: 0.5 veya 1.25).\nEğer maliyet yoksa veya değiştirmek istemiyorsanız <b>0</b> yazabilirsiniz:`, { parse_mode: 'HTML' });
      } catch (err) {
        console.error(err);
        ctx.reply('❌ Veritabanına yazılırken bir hata oluştu.');
      }
    }
    else if (state.startsWith('waiting_stock_cost_')) {
      const productId = parseInt(state.split('_')[3], 10);
      const costUsd = parseMoney(ctx.message.text);
      
      if (costUsd === null || costUsd < 0) {
        return ctx.reply('❌ Lütfen geçerli bir maliyet tutarı girin (Örn: 0.50).');
      }

      try {
        db.prepare('UPDATE products SET cost_usd = ? WHERE id = ?').run(costUsd, productId);
        ctx.session.adminState = null;
        ctx.reply(`✅ Stok maliyeti başarıyla <b>${costUsd} USD</b> olarak güncellendi!`, { parse_mode: 'HTML' });
      } catch (err) {
        console.error(err);
        ctx.reply('❌ Maliyet güncellenirken hata oluştu.');
      }
    }
    else if (state.startsWith('waiting_ms_qty_')) {
      const productId = parseInt(state.split('_')[3], 10);
      const qty = parseInt(ctx.message.text.trim(), 10);
      
      if (isNaN(qty) || qty <= 0) {
        return ctx.reply('❌ Lütfen geçerli bir adet girin (Örn: 20).');
      }
      
      ctx.session.adminState = `waiting_ms_price_${productId}_${qty}`;
      ctx.reply(`✅ ${qty} adet satılacak.\n\nLütfen toplam satış fiyatını döviz cinsi ile birlikte yazın.\nÖrnek: <b>500 TL</b> veya <b>15 USD</b> (veya 15 $)`, { parse_mode: 'HTML' });
    }
    else if (state.startsWith('waiting_ms_price_')) {
      const parts = state.split('_');
      const productId = parseInt(parts[3], 10);
      const qty = parseInt(parts[4], 10);
      
      const raw = ctx.message.text;
      const isTL = /(TL|TRY|₺)/i.test(raw);
      const amount = parseMoney(raw, { currency: isTL ? 'TL' : 'USD' });
      if (amount === null || amount <= 0) {
        return ctx.reply('❌ Lütfen geçerli bir tutar girin. Örn: 74,45 USD veya 1.450 TL');
      }
      
      ctx.reply('⏳ İşlem gerçekleştiriliyor, stoklar teslim ediliyor...');
      ctx.session.adminState = null;
      
      try {
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
        if (!product) throw new Error('Product not found');
        
        const { getUsdTryRate } = require('../utils/currency');
        const tryRate = await getUsdTryRate();
        
        let finalUsdPrice = amount;
        if (isTL) {
          finalUsdPrice = amount / tryRate;
        }
        
        // Fulfill stock
        let localStockCount = db.prepare('SELECT COUNT(*) as count FROM stocks WHERE product_id = ? AND is_sold = 0').get(productId).count;
        let needed = qty - localStockCount;
        
        if (needed > 0) {
          const SupplierManager = require('../services/SupplierManager');
          const orderResult = await SupplierManager.placeOrder(product, needed);
          const apiResponse = orderResult.result;
          if (apiResponse && apiResponse.success && apiResponse.products) {
            const insertStock = db.prepare('INSERT INTO stocks (product_id, data, is_sold) VALUES (?, ?, 0)');
            const insertMany = db.transaction((prods) => {
              for (const p of prods) insertStock.run(productId, p);
            });
            insertMany(apiResponse.products);
          } else {
             throw new Error('Tedarikçi API hatası: Yeterli stok çekilemedi.');
          }
        }
        
        // Deliver stock
        const deliverStock = db.transaction(() => {
          const stocks = db.prepare('SELECT * FROM stocks WHERE product_id = ? AND is_sold = 0 LIMIT ?').all(productId, qty);
          if (stocks.length < qty) throw new Error('OUT_OF_STOCK');
          
          const deliveryData = [];
          for (const stock of stocks) {
            db.prepare('UPDATE stocks SET is_sold = 1 WHERE id = ?').run(stock.id);
            deliveryData.push(stock.data);
          }
          
          const txid = 'MANUAL_' + Date.now();
          const tryRateValue = (typeof tryRate !== 'undefined') ? tryRate : 33.5;
          db.prepare('INSERT INTO transactions (txid, user_id, product_id, amount, status, amount_try) VALUES (?, ?, ?, ?, ?, ?)').run(
            txid, ctx.from.id, productId, finalUsdPrice, 'completed', finalUsdPrice * tryRateValue
          );
          
          const costUsd = product.cost_usd || 0;
          const profitUsd = finalUsdPrice - (costUsd * qty);
          db.prepare('INSERT INTO orders (user_id, product_id, qty, cost_usd, sell_usd, profit_usd, cost_try, sell_try, profit_try) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
            ctx.from.id, productId, qty, costUsd, finalUsdPrice, profitUsd,
            costUsd * qty * tryRateValue, finalUsdPrice * tryRateValue, profitUsd * tryRateValue
          );
          
          return deliveryData;
        });
        
        const deliveredStocks = deliverStock();
        
        // Format and send to admin
        let prodName = product.name;
        try {
          const parsed = JSON.parse(prodName);
          prodName = parsed['tr'] || parsed['en'] || prodName;
        } catch(e) {}
        let msg = `✅ <b>Manuel Satış Başarılı!</b>\n\n📦 <b>Ürün:</b> ${prodName}\n🔢 <b>Adet:</b> ${qty}\n💰 <b>Tutar:</b> ${amount} ${isTL ? 'TL' : 'USD'} (≈ ${finalUsdPrice.toFixed(2)}$)\n\n👇 <b>Teslim Edilen Stoklar:</b>\n`;
        deliveredStocks.forEach((s, idx) => {
          msg += `${idx+1}. <code>${s}</code>\n`;
        });
        
        // Avoid sending too large messages
        if (msg.length > 4000) {
           const fs = require('fs');
           const path = require('path');
           const tmpFile = path.join(__dirname, 'manual_sale.txt');
           fs.writeFileSync(tmpFile, deliveredStocks.join('\n'));
           await ctx.replyWithDocument({ source: tmpFile, filename: `${product.name}_satilanlar.txt` }, {
              caption: `✅ <b>Manuel Satış Başarılı!</b>\nTutar: ${finalUsdPrice.toFixed(2)}$\nStoklar çok uzun olduğu için dosya olarak eklendi.`,
              parse_mode: 'HTML'
           });
           fs.unlinkSync(tmpFile);
        } else {
           await ctx.reply(msg, { parse_mode: 'HTML' });
        }
        
      } catch (err) {
        console.error('Manual sale error:', err.message);
        ctx.reply('❌ İşlem sırasında bir hata oluştu: ' + err.message);
      }
    }


    // --- Sipariş geliri / maliyeti / kazancı düzenleme ---
    else if (state && state.startsWith('waiting_order_edit_')) {
      const parts = state.split('_'); // waiting_order_edit_<id>_<field>
      const orderId = parseInt(parts[3], 10);
      const field = parts[4];
      const order = db.prepare('SELECT o.*, u.username, p.name as product_name FROM orders o LEFT JOIN users u ON o.user_id = u.id LEFT JOIN products p ON o.product_id = p.id WHERE o.id = ?').get(orderId);
      if (!order) {
        ctx.session.adminState = null;
        return ctx.reply('❌ Sipariş bulunamadı.');
      }

      const input = parseMoney(ctx.message.text);
      if (input === null || input < 0) {
        return ctx.reply('❌ Geçerli bir tutar girin (Örn: 74,45 veya 2.90).');
      }

      const updated = { ...order };
      let note;
      if (field === 'sell') {
        updated.sell_usd = input;
        note = `gelir ${order.sell_usd} -> ${input}`;
      } else if (field === 'cost') {
        updated.cost_usd = input;
        note = `maliyet ${order.cost_usd} -> ${input}`;
      } else { // profit -> derive sell so profit_usd becomes exactly `input`
        const cost = parseFloat(order.cost_usd) || 0;
        updated.sell_usd = input + cost * (order.qty || 1);
        note = `kâr ${order.profit_usd} -> ${input}`;
      }

      const calc = recalcOrder(updated);
      db.prepare(`
        UPDATE orders
        SET sell_usd = @sell_usd, sell_try = @sell_try,
            cost_usd = @cost_usd, cost_try = @cost_try,
            profit_usd = @profit_usd, profit_try = @profit_try,
            edited_by = @edited_by, edited_at = CURRENT_TIMESTAMP, edit_note = @edit_note
        WHERE id = @id
      `).run({ ...calc, edited_by: ctx.from.id, edit_note: note, id: orderId });

      // Keep the matching transaction row in sync when it is unambiguous,
      // otherwise the wallet/stat screens would disagree with orders.
      if (field !== 'cost') {
        const newSell = calc.sell_usd;
        const oldSell = parseFloat(order.sell_usd) || 0;
        const tx = db.prepare(
          "SELECT id FROM transactions WHERE user_id = ? AND product_id = ? AND CAST(amount AS REAL) = CAST(? AS REAL) AND status IN ('SUCCESS','completed') ORDER BY id DESC LIMIT 2"
        ).all(order.user_id, order.product_id, oldSell);
        if (tx.length === 1) {
          const rate = oldSell > 0 ? calc.sell_try / calc.sell_usd : 47.22;
          db.prepare('UPDATE transactions SET amount = ?, amount_try = ? WHERE id = ?').run(newSell, newSell * rate, tx[0].id);
        }
      }

      // A reservation-linked order (qty 0 style reservation orders) also carries
      // profit columns; mirror the same edit there if one matches.
      const linkedRes = db.prepare(
        'SELECT id FROM reservations WHERE user_id = ? AND product_id = ? AND CAST(sell_usd AS REAL) = CAST(? AS REAL) ORDER BY id DESC LIMIT 1'
      ).get(order.user_id, order.product_id, order.sell_usd);
      if (linkedRes && field !== 'profit') {
        const res = db.prepare('SELECT * FROM reservations WHERE id = ?').get(linkedRes.id);
        const resCalc = recalcOrder({ ...res, sell_usd: field === 'sell' ? calc.sell_usd : res.sell_usd, cost_usd: field === 'cost' ? calc.cost_usd : res.cost_usd });
        db.prepare('UPDATE reservations SET sell_usd=?, sell_try=?, cost_usd=?, cost_try=?, profit_usd=?, profit_try=? WHERE id=?')
          .run(resCalc.sell_usd, resCalc.sell_try, resCalc.cost_usd, resCalc.cost_try, resCalc.profit_usd, resCalc.profit_try, linkedRes.id);
      }

      ctx.session.adminState = null;

      const after = db.prepare('SELECT o.*, u.username, p.name as product_name FROM orders o LEFT JOIN users u ON o.user_id = u.id LEFT JOIN products p ON o.product_id = p.id WHERE o.id = ?').get(orderId);
      let pName = after.product_name || 'Bilinmiyor';
      try { const parsed = JSON.parse(pName); pName = parsed['tr'] || parsed['en'] || pName; } catch (e) {}

      ctx.reply(`✅ Sipariş #${orderId} güncellendi (${note}).`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Sipariş Detayı', callback_data: `admin_order_detail_${orderId}` }]] }
      }).catch(() => {});
      ctx.reply(orderDetailText(after, pName), { parse_mode: 'HTML' }).catch(() => {});
    }


    // --- Ürün varsayılan kâr / alt limit girişleri ---
    else if (state && state.startsWith('waiting_product_margin_')) {
      const productId = parseInt(state.split('_')[3], 10);
      const margin = parseMoney(ctx.message.text);
      if (margin === null || margin < 0 || margin > 100000) return ctx.reply('❌ Geçerli bir yüzde girin (Örn: 150).');
      db.prepare('UPDATE products SET default_margin_percent = ? WHERE id = ?').run(margin, productId);
      ctx.session.adminState = null;
      ctx.reply(`✅ Ürün #${productId} varsayılan kâr: %${margin}`, {
        reply_markup: { inline_keyboard: [[{ text: '🧮 Fiyalama Ekranı', callback_data: `admin_prod_pricing_${productId}` }]] }
      });
    }
    else if (state && state.startsWith('waiting_product_floor_')) {
      const productId = parseInt(state.split('_')[3], 10);
      const floor = parseMoney(ctx.message.text);
      if (floor === null || floor < 0) return ctx.reply('❌ Geçerli bir alt limit girin (0 = yok).');
      db.prepare('UPDATE products SET default_floor_price = ? WHERE id = ?').run(floor, productId);
      ctx.session.adminState = null;
      ctx.reply(`✅ Ürün #${productId} alt limit: $${floor}`, {
        reply_markup: { inline_keyboard: [[{ text: '🧮 Fiyalama Ekranı', callback_data: `admin_prod_pricing_${productId}` }]] }
      });
    }

    else if (state && state.startsWith('waiting_link_margin_')) {
      const parts = state.split('_'); // waiting_link_margin_<productId>_<psId>
      const productId = parseInt(parts[3], 10);
      const psId = parseInt(parts[4], 10);
      const txt = ctx.message.text.trim();
      if (/^(clear|varsayilan|default)$/i.test(txt)) {
        db.prepare('UPDATE product_suppliers SET margin_percent = NULL WHERE id = ?').run(psId);
      } else {
        const margin = parseMoney(txt);
        if (margin === null || margin < 0 || margin > 100000) return ctx.reply('❌ Geçerli bir yüzde girin (Örn: 150) veya "clear" yazın.');
        db.prepare('UPDATE product_suppliers SET margin_percent = ? WHERE id = ?').run(margin, psId);
      }
      ctx.session.adminState = null;
      return ctx.reply(`✅ Bağlantı #${psId} kâr ayarlandı.`, {
        reply_markup: { inline_keyboard: [[{ text: '🏭 Teklif Detayı', callback_data: `admin_prod_sup_detail_${productId}_${psId}` }]] }
      });
    }
    else if (state && state.startsWith('waiting_link_floor_')) {
      const parts = state.split('_');
      const productId = parseInt(parts[3], 10);
      const psId = parseInt(parts[4], 10);
      const txt = ctx.message.text.trim();
      if (/^(clear|varsayilan|default)$/i.test(txt)) {
        db.prepare('UPDATE product_suppliers SET floor_price = NULL WHERE id = ?').run(psId);
      } else {
        const floor = parseMoney(txt);
        if (floor === null || floor < 0) return ctx.reply('❌ Geçerli bir alt limit girin (Örn: 3) veya "clear" yazın.');
        db.prepare('UPDATE product_suppliers SET floor_price = ? WHERE id = ?').run(floor, psId);
      }
      ctx.session.adminState = null;
      return ctx.reply(`✅ Bağlantı #${psId} alt limit ayarlandı.`, {
        reply_markup: { inline_keyboard: [[{ text: '🏭 Teklif Detayı', callback_data: `admin_prod_sup_detail_${productId}_${psId}` }]] }
      });
    }

    else if (state === 'waiting_group_add') {
      const args = ctx.message.text.split(' ');
      if (args.length < 2) return ctx.reply('❌ Hatalı format. Örn: VIP 15');
      const discount = parseMoney(args.pop());
      const name = args.join(' ');
      try {
        const info = db.prepare('INSERT INTO pricing_groups (name, discount_percent) VALUES (?, ?)').run(name, discount);
        ctx.reply(`✅ Grup oluşturuldu! ID: ${info.lastInsertRowid}`);
        ctx.session.adminState = null;
      } catch(e) { ctx.reply(`❌ Hata: ${e.message}`); }
    }
    
    else if (state === 'waiting_group_adduser') {
      const args = ctx.message.text.split(' ');
      if (args.length < 2) return ctx.reply('❌ Hatalı format. Örn: 123456789 2');
      const userId = parseInt(args[0], 10);
      const groupId = parseInt(args[1], 10);
      try {
        db.prepare('DELETE FROM user_pricing_groups WHERE user_id = ?').run(userId);
        db.prepare('INSERT INTO user_pricing_groups (user_id, group_id) VALUES (?, ?)').run(userId, groupId);
        ctx.reply(`✅ Kullanıcı gruba eklendi!`);
        ctx.session.adminState = null;
      } catch(e) { ctx.reply(`❌ Hata: ${e.message}`); }
    }
    
    else if (state === 'waiting_group_setprice') {
      const args = ctx.message.text.split(' ');
      if (args.length < 3) return ctx.reply('❌ Hatalı format. Örn: 2 1 5.5');
      const groupId = parseInt(args[0], 10);
      const productId = parseInt(args[1], 10);
      const price = parseFloat(args[2]);
      try {
        db.prepare(`INSERT INTO pricing_group_products (group_id, product_id, price) VALUES (?, ?, ?) ON CONFLICT(group_id, product_id) DO UPDATE SET price = excluded.price`).run(groupId, productId, price);
        ctx.reply(`✅ Gruba özel fiyat eklendi!`);
        ctx.session.adminState = null;
      } catch(e) { ctx.reply(`❌ Hata: ${e.message}`); }
    }

    else if (state === 'waiting_bulk_list') {
      const productId = parseInt(ctx.message.text, 10);
      const discounts = db.prepare('SELECT * FROM product_bulk_discounts WHERE product_id = ? ORDER BY min_qty ASC').all(productId);
      if (discounts.length === 0) return ctx.reply('❌ Bu ürüne ait indirim bulunamadı.');
      let msg = `<b>Ürün ${productId} İndirimleri:</b>\n\n`;
      discounts.forEach(d => {
        msg += `Kural ID: <b>${d.id}</b> | Min Adet: ${d.min_qty} | `;
        if (d.fixed_price !== null && d.fixed_price !== undefined) msg += `Sabit Fiyat: ${d.fixed_price}$\n`;
        else msg += `İndirim: ${d.discount_percent}%\n`;
      });
      ctx.reply(msg, { parse_mode: 'HTML' });
      ctx.session.adminState = null;
    }
    
    else if (state === 'waiting_bulk_add') {
      const args = ctx.message.text.split(' ');
      if (args.length < 4) return ctx.reply('❌ Hatalı format. Örn: 1 50 percent 25');
      const productId = parseInt(args[0], 10);
      const minQty = parseInt(args[1], 10);
      const type = args[2].toLowerCase();
      const value = parseFloat(args[3]);
      
      let discount_percent = 0;
      let fixed_price = null;
      if (type === 'percent') discount_percent = value;
      else if (type === 'fixed') fixed_price = value;
      else return ctx.reply('❌ Tip "percent" veya "fixed" olmalıdır.');
      
      try {
        db.prepare(`INSERT INTO product_bulk_discounts (product_id, min_qty, discount_percent, fixed_price) VALUES (?, ?, ?, ?)`).run(productId, minQty, discount_percent, fixed_price);
        ctx.reply(`✅ Toplu alım indirimi eklendi!`);
        ctx.session.adminState = null;
      } catch(e) { ctx.reply(`❌ Hata: ${e.message}`); }
    }
    
    else if (state === 'waiting_bulk_delete') {
      const id = parseInt(ctx.message.text, 10);
      try {
        db.prepare('DELETE FROM product_bulk_discounts WHERE id = ?').run(id);
        ctx.reply(`✅ İndirim silindi!`);
        ctx.session.adminState = null;
      } catch(e) { ctx.reply(`❌ Hata: ${e.message}`); }
    }

    else if (state === 'waiting_add_supplier') {
      const parts = ctx.message.text.split('|').map(s => s.trim());
      if (parts.length < 4) return ctx.reply('❌ Hatalı format. Örn: MyLoot | lootpaglu | https://api.com | 123456');
      try {
        db.prepare('INSERT INTO suppliers (name, type, base_url, api_key) VALUES (?, ?, ?, ?)').run(parts[0], parts[1], parts[2], parts[3]);
        ctx.reply(`✅ Tedarikçi başarıyla eklendi!`);
        ctx.session.adminState = null;
      } catch(e) { ctx.reply(`❌ Hata: ${e.message}`); }
    }

    else if (state === 'waiting_autobuy_threshold') {
      const parts = ctx.message.text.split(' ');
      if (parts.length < 3) return ctx.reply('❌ Lütfen Aktiflik, Sınır ve Adeti aralarında boşluk bırakarak yazın (Örn: 1 2 5)');
      
      const enabled = parseInt(parts[0], 10);
      const threshold = parseInt(parts[1], 10);
      const qty = parseInt(parts[2], 10);

      if (isNaN(enabled) || isNaN(threshold) || isNaN(qty)) {
        return ctx.reply('❌ Girdiğiniz değerler sayı olmalıdır.');
      }
      
      const productId = ctx.session.autobuyProductId;
      
      try {
        db.prepare('UPDATE products SET auto_restock_enabled = ?, auto_restock_threshold = ?, auto_restock_qty = ? WHERE id = ?').run(enabled, threshold, qty, productId);
        
        ctx.reply(`⏳ Ayarlar kaydediliyor... Fiyatlar kontrol ediliyor.`);
        
        // Find mapped suppliers and compute potential accounts can buy
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
        const mappedSuppliers = db.prepare(`SELECT ps.*, s.type, s.base_url, s.api_key, s.name FROM product_suppliers ps JOIN suppliers s ON ps.supplier_id = s.id WHERE ps.product_id = ? ORDER BY ps.priority ASC`).all(productId);
        
        let extraMsg = '';
        if (enabled && mappedSuppliers.length > 0) {
          // If enabled, let's just try to fetch price from the first supplier (or all)
          // For simplicity we just show how many we can buy if it's Lootpaglu.
          extraMsg += `\n\n🔍 <b>Bağlı Tedarikçiler (Önizleme):</b>\n`;
          for (const m of mappedSuppliers) {
            extraMsg += `- ${m.name}: `;
            if (m.type === 'lootpaglu') {
               // We will try to get wallet balance
               try {
                 const adapter = require('../services/adapters/lootpaglu');
                 const price = await adapter.getPrice(m);
                 extraMsg += `Fiyat = ${price} INR`;
               } catch (e) {
                 extraMsg += `(Fiyat alınamadı)`;
               }
            } else {
               extraMsg += `Bağlı`;
            }
            extraMsg += `\n`;
          }
        }
        
        ctx.reply(`✅ <b>Otomatik Alım Kurulumu Tamamlandı!</b>\nÜrün ID: ${productId}\nAktif: ${enabled ? 'Evet' : 'Hayır'}\nSınır: ${threshold}\nAdet: ${qty}${extraMsg}`, { parse_mode: 'HTML' });
        
        ctx.session.adminState = null;
        ctx.session.autobuyProductId = null;
      } catch(e) { ctx.reply(`❌ Hata: ${e.message}`); }
    }

    // MEGA UPDATE: Bakiye Yönetimi — ID, @username veya iletmeden otomatik tanımlama
    else if (state === 'waiting_balance_user_id') {
      let target = null;

      const fu = forwardedUser(ctx);
      if (fu) {
        ensureUserRow(fu);
        target = db.prepare('SELECT * FROM users WHERE id = ?').get(fu.id);
        ctx.reply(`📩 İletilen mesajdan çözüldü: <b>${(target && target.username ? '@' + target.username : (fu.first_name || fu.id))}</b>\n<code>${fu.id}</code>`, { parse_mode: 'HTML' });
      } else {
        const r = resolveUserToken(ctx.message.text || ctx.message.caption);
        if (r.error) return ctx.reply(r.error, { parse_mode: 'HTML' });
        target = r.user;
      }

      ctx.session.adminState = 'waiting_balance_amount';
      ctx.session.balanceUserId = target.id;

      const who = `${target.username ? '@' + target.username : (target.first_name || '')} <code>${target.id}</code>`;
      ctx.reply(
        `👤 Hedef: ${who}\nMevcut bakiye: <b>${(target.balance || 0).toFixed(2)}$</b>\n\n` +
        `Eklenecek tutarı girin (Silmek için başına - koyun, örn: -5):`,
        { parse_mode: 'HTML' }
      );
    }
    else if (state === 'waiting_balance_amount') {
      const amount = parseMoney(ctx.message.text);
      if (amount === null) return ctx.reply('❌ Geçerli bir tutar girin (örn: 10 veya 10,50 veya -5).');
      const uid = ctx.session.balanceUserId;

      const before = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid);
      if (!before) {
        ctx.session.adminState = null;
        return ctx.reply('❌ Kullanıcı kaydı bulunamadı (kişi botu hiç başlatmamış).');
      }
      if ((before.balance || 0) + amount < 0) {
        return ctx.reply(`❌ Bakiye eksiye düşer (mevcut: ${(before.balance || 0).toFixed(2)}$). Daha küçük bir silme tutarı girin veya iptal edin.`);
      }

      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, uid);
      sendWalletTopUpLog(ctx.telegram, uid, amount);
      const after = ((before.balance || 0) + amount).toFixed(2);
      ctx.reply(
        `✅ ${amount >= 0 ? 'Yükleme' : 'Düşüm'}: <b>${amount}$</b>\nYeni bakiye: <b>${after}$</b> (<code>${uid}</code>)`,
        { parse_mode: 'HTML' }
      );
      ctx.session.adminState = null;
    }

    // MEGA UPDATE: Promo Kod Yönetimi
    else if (state === 'waiting_promo_code_name') {
      ctx.session.promoCodeName = ctx.message.text.trim();
      ctx.session.adminState = 'waiting_promo_type';
      ctx.reply('Promo kod tipini seçin:\nYazın: bakiye VEYA indirim');
    }
    else if (state === 'waiting_promo_type') {
      const typeStr = ctx.message.text.trim().toLowerCase();
      if (typeStr !== 'bakiye' && typeStr !== 'indirim') return ctx.reply('Lütfen "bakiye" veya "indirim" yazın.');
      ctx.session.promoType = typeStr === 'bakiye' ? 'balance' : 'discount';
      ctx.session.adminState = 'waiting_promo_val';
      ctx.reply('Değeri girin (Örn: Bakiye için 2, indirim için 15):');
    }
    else if (state === 'waiting_promo_val') {
      const val = parseMoney(ctx.message.text);
      if (val === null) return ctx.reply('❌ Geçerli sayı girin.');
      ctx.session.promoVal = val;
      ctx.session.adminState = 'waiting_promo_expires';
      ctx.reply('Kaç saat geçerli olacak? (Sınırsız için 0 yazın):');
    }
    else if (state === 'waiting_promo_expires') {
      const hours = parseInt(ctx.message.text.trim(), 10);
      if (isNaN(hours)) return ctx.reply('❌ Geçerli saat girin.');
      
      try {
        db.prepare('INSERT INTO promo_codes (code, type, value, max_uses, expiry_hours) VALUES (?, ?, ?, ?, ?)').run(
          ctx.session.promoCodeName, ctx.session.promoType, ctx.session.promoVal, 9999, hours > 0 ? hours : null
        );
        ctx.reply(`✅ Promo kod oluşturuldu: ${ctx.session.promoCodeName}`);
      } catch (e) {
        ctx.reply(`❌ Hata: ${e.message}`);
      }
      ctx.session.adminState = null;
    }

    // MEGA UPDATE: Rank Ekleme
    else if (state === 'waiting_rank_name') {
      ctx.session.rankName = ctx.message.text.trim();
      ctx.session.adminState = 'waiting_rank_min';
      ctx.reply('Bu rank için minimum toplam satın alım sayısı (Örn: 50):');
    }
    else if (state === 'waiting_rank_min') {
      const min = parseInt(ctx.message.text.trim(), 10);
      if (isNaN(min)) return ctx.reply('❌ Sayı girin.');
      ctx.session.rankMin = min;
      ctx.session.adminState = 'waiting_rank_discount';
      ctx.reply('Global indirim yüzdesi (Sadece özel ürün fiyatı olacaksa 0 yazın):');
    }
    else if (state === 'waiting_rank_discount') {
      const disc = parseMoney(ctx.message.text);
      if (disc === null) return ctx.reply('❌ Sayı girin.');
      
      try {
        db.prepare('INSERT INTO ranks (name, min_purchases, discount_percent) VALUES (?, ?, ?)').run(
          ctx.session.rankName, ctx.session.rankMin, disc
        );
        ctx.reply(`✅ Rank "${ctx.session.rankName}" eklendi.`);
      } catch (e) {
        ctx.reply(`❌ Hata: ${e.message}`);
      }
      ctx.session.adminState = null;
    }

    // MEGA UPDATE: Bayi Ekleme
    else if (state === 'waiting_reseller_user_id') {
      const uid = parseInt(ctx.message.text.trim(), 10);
      if (isNaN(uid)) return ctx.reply('❌ Sayı girin.');
      ctx.session.resellerUserId = uid;
      ctx.session.adminState = 'waiting_reseller_limit';
      ctx.reply('Bayiye tanınacak limit bakiye (Sınırsız ise 0 yazın):');
    }
    else if (state === 'waiting_reseller_limit') {
      const limit = parseMoney(ctx.message.text);
      if (limit === null) return ctx.reply('❌ Sayı girin.');
      
      try {
        const adminId = ctx.from.id;
        db.prepare('INSERT INTO resellers (user_id, balance_limit, created_by) VALUES (?, ?, ?)').run(
          ctx.session.resellerUserId, limit, adminId
        );
        ctx.reply(`✅ Bayi eklendi (ID: ${ctx.session.resellerUserId}, Limit: ${limit}).`);
      } catch (e) {
        ctx.reply(`❌ Hata: ${e.message}`);
      }
      ctx.session.adminState = null;
    }

    else if (state === 'waiting_tier_min') {
      const min = parseInt(ctx.message.text.trim(), 10);
      if (isNaN(min)) return ctx.reply('❌ Lütfen geçerli bir sayı girin.');
      
      ctx.session.buildingTierTemp = { min: min };
      ctx.session.adminState = 'waiting_tier_max';
      
      ctx.reply('🏷️ <b>Kademe Ekleme Sihirbazı (2/3)</b>\n\nBu kademenin bitiş (maksimum) adetini yazın:\n<i>(Sınırsız ise 0 yazın. Örn: 299)</i>', {
         parse_mode: 'HTML',
         reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: `admin_set_tiers_${ctx.session.tierProductSupplierId}_${ctx.session.tierProductId}` }]] }
      });
    }

    else if (state === 'waiting_tier_max') {
      const input = ctx.message.text.trim();
      const max = parseInt(input, 10);
      if (isNaN(max)) return ctx.reply('❌ Lütfen geçerli bir sayı girin.');
      
      ctx.session.buildingTierTemp.max = max === 0 ? null : max;
      ctx.session.adminState = 'waiting_tier_price';
      
      ctx.reply('🏷️ <b>Kademe Ekleme Sihirbazı (3/3)</b>\n\nBu kademe aralığı için geçerli olacak birim fiyatı girin:\n<i>Örn: 0.45</i>', {
         parse_mode: 'HTML',
         reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: `admin_set_tiers_${ctx.session.tierProductSupplierId}_${ctx.session.tierProductId}` }]] }
      });
    }

    else if (state === 'waiting_tier_price') {
      const price = parseMoney(ctx.message.text);
      if (price === null) return ctx.reply('❌ Lütfen geçerli bir sayı (fiyat) girin.');
      
      ctx.session.buildingTierTemp.price = price;
      
      // Save it to the array
      ctx.session.buildingTiers = ctx.session.buildingTiers || [];
      ctx.session.buildingTiers.push(ctx.session.buildingTierTemp);
      ctx.session.buildingTierTemp = null;
      ctx.session.adminState = null;
      
      const psId = ctx.session.tierProductSupplierId;
      ctx.reply('✅ Başarıyla geçici listeye eklendi!\n\nBaşka bir kademe daha eklemek istiyor musunuz?', {
         reply_markup: {
            inline_keyboard: [
               [{ text: '➕ Evet, Ekle', callback_data: `admin_tier_add_start_${psId}` }],
               [{ text: '💾 Bitti, Kademeleri Kaydet', callback_data: `admin_tier_finish_${psId}` }]
            ]
         }
      });
    }

    else if (state === 'waiting_reservation_fee') {
      const fee = parseMoney(ctx.message.text);
      if (fee === null || fee < 0) {
        return ctx.reply('❌ Geçersiz bir sayı girdiniz. Lütfen pozitif bir ücret girin (örn: 0.10).');
      }
      
      const existing = db.prepare('SELECT * FROM settings WHERE key = ?').get('reservation_fee');
      if (existing) {
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(fee.toString(), 'reservation_fee');
      } else {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('reservation_fee', fee.toString());
      }
      
      ctx.session.adminState = null;
      ctx.reply(`✅ Rezervasyon ücreti başarıyla güncellendi: ${fee}$`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Ayarlar Menüsü', callback_data: 'admin_settings_menu' }]] }
      });
    }

    else {
      return next();
    }
  });

  bot.action('admin_settings_menu', adminMiddleware, (ctx) => {
    const feeRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('reservation_fee');
    const fee = feeRow ? parseFloat(feeRow.value).toFixed(2) : '0.10';

    ctx.editMessageText(`🛠 <b>Genel Ayarlar</b>\n\n📌 <b>Rezerve Ücreti:</b> ${fee}$ (Ürün başına sabit ücret)`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✏️ Rezerve Ücretini Değiştir', callback_data: 'admin_edit_reserve_fee' }],
          [{ text: '🔙 Ana Menü', callback_data: 'admin_back_main' }]
        ]
      }
    });
  });

  bot.action('admin_edit_reserve_fee', adminMiddleware, (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.adminState = 'waiting_reservation_fee';
    ctx.editMessageText('Lütfen yeni rezervasyon ücretini yazın (örn: 0.10):', {
      reply_markup: {
        inline_keyboard: [[{ text: '❌ İptal', callback_data: 'admin_settings_menu' }]]
      }
    });
  });
}

module.exports = setupAdminHandlers;
