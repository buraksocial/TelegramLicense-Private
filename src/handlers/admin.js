const { db } = require('../db');
const { broadcastMessage } = require('../bot');
const { sendWalletTopUpLog, sendRestockLog } = require('../utils/logger');
const { ADMIN_ID } = require('../config/env');
const axios = require('axios');
const { t } = require('../utils/i18n');
const setupAdminApiHandlers = require('./admin_api');
const SupplierManager = require('../services/SupplierManager');

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
    
    const fee = parseFloat(feeStr);
    if (isNaN(fee) || fee < 0) return ctx.reply('Geçersiz ücret miktarı.');
    
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
    buttons.push([{ text: '🔙 Ana Menü', callback_data: 'admin_back_main' }]);

    ctx.editMessageText(`📦 <b>Ürün Yönetimi (Sayfa ${page})</b>\nLütfen detaylarını görmek istediğiniz ürünü seçin:`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }).catch(e => {});
  });

  bot.action(/^admin_product_detail_(\d+)$/, adminMiddleware, (ctx) => {
    const productId = parseInt(ctx.match[1], 10);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) return ctx.answerCbQuery('Ürün bulunamadı!', { show_alert: true });

    const stockCount = db.prepare('SELECT COUNT(*) as c FROM stocks WHERE product_id = ? AND is_sold = 0').get(productId).c;
    
    let name = product.name;
    try {
      const parsed = JSON.parse(name);
      name = parsed['tr'] || parsed['en'] || name;
    } catch (e) {}

    const text = `📦 <b>Ürün Detayı:</b> ${name}\n\n💵 <b>Satış Fiyatı:</b> ${product.price} USD\n💰 <b>Birim Maliyet:</b> ${product.cost_usd || 0} USD\n🛒 <b>Mevcut Stok:</b> ${stockCount} adet`;

    ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Stok Ekle', callback_data: `admin_sel_stock_${productId}` }],
          [{ text: '📝 İsmini Düzenle', callback_data: `admin_prod_edit_name_${productId}` }],
          [{ text: '💵 Fiyat/Maliyet Düzenle', callback_data: `admin_prod_edit_price_${productId}` }],
          [{ text: '🎁 Toplu Alım Kuralları', callback_data: `admin_prod_bulk_${productId}` }],
          [{ text: '📈 Tüm Fiyatlara Zam Yap (%)', callback_data: `admin_prod_increase_${productId}` }],
          [{ text: '🗑 Ürünü Sil', callback_data: `admin_prod_del_confirm_${productId}` }],
          [{ text: '🔙 Ürün Listesine Dön', callback_data: 'admin_products_menu' }]
        ]
      }
    }).catch(e => {});
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
    
    const allOrders = db.prepare('SELECT * FROM orders').all();
    
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

  bot.action('admin_balance_menu', adminMiddleware, (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.adminState = 'waiting_balance_user_id';
    ctx.editMessageText('💼 <b>Bakiye Yönetimi</b>\nLütfen bakiyesini güncellemek istediğiniz kullanıcının <b>User ID</b>\'sini yazın:', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: 'admin_cancel' }]] }
    }).catch(e => {});
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

    const totalCount = db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
    if (totalCount === 0) return ctx.answerCbQuery('Hiç sipariş bulunamadı.', { show_alert: true });

    const orders = db.prepare('SELECT o.*, u.username, p.name as product_name FROM orders o LEFT JOIN users u ON o.user_id = u.id LEFT JOIN products p ON o.product_id = p.id ORDER BY o.id DESC LIMIT ? OFFSET ?').all(limit, offset);
    
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

  bot.action(/^admin_order_detail_(\d+)$/, adminMiddleware, (ctx) => {
    const orderId = parseInt(ctx.match[1], 10);
    const order = db.prepare('SELECT o.*, u.username, p.name as product_name FROM orders o LEFT JOIN users u ON o.user_id = u.id LEFT JOIN products p ON o.product_id = p.id WHERE o.id = ?').get(orderId);
    
    if (!order) return ctx.answerCbQuery('Sipariş bulunamadı.', { show_alert: true });

    let pName = order.product_name || 'Bilinmiyor';
    try { const parsed = JSON.parse(pName); pName = parsed['tr'] || parsed['en'] || pName; } catch (e) {}

    const text = `🟢 <b>Sipariş Detayı (#${order.id})</b>\n\n👤 Kullanıcı: @${order.username || order.user_id} (ID: ${order.user_id})\n📦 Ürün: ${pName}\n🔢 Adet: ${order.qty}\n💵 Ödenen: ${order.sell_usd} USD\n📅 Tarih: ${order.created_at}`;

    ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ İptal Et (Ücret İadesi Yap)', callback_data: `admin_order_cancel_${order.id}_yes` }],
          [{ text: '❌ İptal Et (İade Yapma)', callback_data: `admin_order_cancel_${order.id}_no` }],
          [{ text: '🔙 Listeye Dön', callback_data: 'admin_recent_completed_1' }]
        ]
      }
    }).catch(e => {});
  });

  bot.action(/^admin_order_cancel_(\d+)_([a-z]+)$/, adminMiddleware, (ctx) => {
    const orderId = parseInt(ctx.match[1], 10);
    const refund = ctx.match[2] === 'yes';

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return ctx.answerCbQuery('Sipariş bulunamadı.', { show_alert: true });

    if (refund) {
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(order.sell_usd, order.user_id);
    }
    
    // orders tablosundan siliyoruz ki listeden kaybolsun (veya status eklemesi yapabilirsiniz ama mevcut şemada status yok)
    db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);

    const msg = refund ? `✅ Sipariş silindi ve <b>${order.sell_usd} USD</b> bakiye kullanıcıya (ID: ${order.user_id}) iade edildi.` : `✅ Sipariş silindi. (İade yapılmadı)`;
    
    ctx.answerCbQuery('İşlem başarılı.').catch(()=>null);
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
      
      const price = parseFloat(ctx.message.text.trim().replace(',', '.'));
      if (isNaN(price) || price <= 0) {
        return ctx.reply('❌ Lütfen geçerli bir fiyat girin (Örn: 15 veya 10.5)');
      }

      ctx.session.newProductPrice = price;
      ctx.session.adminState = 'waiting_product_cost';

      ctx.reply(`✅ Satış Fiyatı: <b>${price} USD</b>\n\nŞimdi lütfen bu ürünün <b>Birim Maliyetini (USD)</b> girin (Örn: 0.5 veya 1.25).\nEğer maliyet yoksa 0 yazabilirsiniz:`, { parse_mode: 'HTML' });
    }

    // --- Ürün Ekleme: Maliyet Bekleniyor ---
    else if (state === 'waiting_product_cost') {
      if (!ctx.message.text) return ctx.reply('❌ Lütfen sadece sayı gönderin.');
      
      const costUsd = parseFloat(ctx.message.text.trim().replace(',', '.'));
      if (isNaN(costUsd) || costUsd < 0) {
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
      const percentageStr = ctx.message.text.trim().replace('%', '');
      const percentage = parseFloat(percentageStr);

      if (isNaN(percentage)) {
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
      const price = parseFloat(ctx.message.text.trim().replace(',', '.'));
      if (isNaN(price) || price <= 0) return ctx.reply('❌ Geçerli bir fiyat girin.');
      
      db.prepare('UPDATE products SET price = ? WHERE id = ?').run(price, productId);
      ctx.session.adminState = `waiting_edit_cost_${productId}`;
      ctx.reply(`✅ Satış fiyatı güncellendi!\n\nŞimdi lütfen yeni <b>Birim Maliyeti (USD)</b> girin (0 yazabilirsiniz):`, { parse_mode: 'HTML' });
    }
    else if (state && state.startsWith('waiting_edit_cost_')) {
      const productId = parseInt(state.split('_')[3], 10);
      const cost = parseFloat(ctx.message.text.trim().replace(',', '.'));
      if (isNaN(cost) || cost < 0) return ctx.reply('❌ Geçerli bir maliyet girin.');
      
      db.prepare('UPDATE products SET cost_usd = ? WHERE id = ?').run(cost, productId);
      ctx.session.adminState = null;
      ctx.reply(`✅ Ürün fiyat ve maliyet bilgileri başarıyla güncellendi!`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Ürüne Dön', callback_data: `admin_product_detail_${productId}` }]] }
      });
    }
    else if (state && state.startsWith('waiting_bulk_qty_')) {
      const productId = parseInt(state.split('_')[3], 10);
      const qty = parseInt(ctx.message.text.trim(), 10);
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
      
      const val = parseFloat(ctx.message.text.trim().replace(',', '.'));
      if (isNaN(val) || val <= 0) return ctx.reply('❌ Geçerli bir miktar girin.');
      
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
      const input = ctx.message.text.trim().replace(',', '.');
      const costUsd = parseFloat(input);
      
      if (isNaN(costUsd) || costUsd < 0) {
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
      
      const input = ctx.message.text.trim().toUpperCase();
      let normalizedInput = input.replace(/,/g, '.');
      let amount = parseFloat(normalizedInput.replace(/[^0-9.]/g, ''));
      if (isNaN(amount) || amount <= 0) {
        return ctx.reply('❌ Lütfen geçerli bir tutar girin.');
      }
      
      const isTL = input.includes('TL') || input.includes('TRY');
      
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


    else if (state === 'waiting_group_add') {
      const args = ctx.message.text.split(' ');
      if (args.length < 2) return ctx.reply('❌ Hatalı format. Örn: VIP 15');
      const discount = parseFloat(args.pop());
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

    else if (state === 'waiting_link_supplier_service_id') {
      const remoteId = ctx.message.text.trim();
      const sId = ctx.session.linkSupplierId;
      const pId = ctx.session.linkProductId;
      
      try {
        const highestPrio = db.prepare('SELECT MAX(priority) as p FROM product_suppliers WHERE product_id = ?').get(pId).p || 0;
        const prio = highestPrio + 1;
        
        db.prepare('INSERT INTO product_suppliers (product_id, supplier_id, remote_service_id, priority) VALUES (?, ?, ?, ?)').run(pId, sId, remoteId, prio);
        ctx.reply(`✅ Tedarikçi başarıyla bağlandı! (Öncelik: ${prio})`);
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

    // MEGA UPDATE: Bakiye Yönetimi
    else if (state === 'waiting_balance_user_id') {
      const uid = parseInt(ctx.message.text.trim(), 10);
      if (isNaN(uid)) return ctx.reply('❌ Geçerli bir User ID girin.');
      ctx.session.adminState = 'waiting_balance_amount';
      ctx.session.balanceUserId = uid;
      
      const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid);
      const curBal = user ? (user.balance || 0).toFixed(2) : 'Kullanıcı bulunamadı/Bakiye 0';
      ctx.reply(`Mevcut bakiye: ${curBal}$\nEklenecek tutarı girin (Silmek için başına - koyun, örn: -5):`);
    }
    else if (state === 'waiting_balance_amount') {
      const amount = parseFloat(ctx.message.text.trim());
      if (isNaN(amount)) return ctx.reply('❌ Geçerli bir tutar girin.');
      const uid = ctx.session.balanceUserId;
      
      try {
        db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, uid);
        sendWalletTopUpLog(ctx.telegram, uid, amount);
        ctx.reply(`✅ Kullanıcının bakiyesi başarıyla <b>${amount}$</b> artırıldı!`, { parse_mode: 'HTML' });
      } catch (e) {
        ctx.reply(`❌ Hata: ${e.message}`);
      }
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
      const val = parseFloat(ctx.message.text.trim());
      if (isNaN(val)) return ctx.reply('❌ Geçerli sayı girin.');
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
      const disc = parseFloat(ctx.message.text.trim());
      if (isNaN(disc)) return ctx.reply('❌ Sayı girin.');
      
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
      const limit = parseFloat(ctx.message.text.trim());
      if (isNaN(limit)) return ctx.reply('❌ Sayı girin.');
      
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
      const price = parseFloat(ctx.message.text.trim());
      if (isNaN(price)) return ctx.reply('❌ Lütfen geçerli bir sayı (fiyat) girin.');
      
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
      const fee = parseFloat(ctx.message.text.trim());
      if (isNaN(fee) || fee < 0) {
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
