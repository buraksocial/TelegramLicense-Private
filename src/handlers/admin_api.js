const { db } = require('../db');
const SupplierManager = require('../services/SupplierManager');
const axios = require('axios');
const CatalogStore = require('../services/CatalogStore');
const { classifyWarranty, LABELS } = require('../utils/warranty');

const PER_PAGE_BIND = 12;

function setupAdminApiHandlers(bot, adminMiddleware) {

  // Main API Menu
  bot.action('admin_api_menu', adminMiddleware, (ctx) => {
    ctx.editMessageText('⚙️ <b>Tedarikçi (API) ve Otomatik Stok Yönetimi</b>\nLütfen bir işlem seçin:', {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏢 Tedarikçi (Supplier) Yönetimi', callback_data: 'admin_supplier_menu' }],
          [{ text: '🔗 Eşleşme Onayı (katalog→ürün)', callback_data: 'admin2_matches_1' }],
          [{ text: '🗂 Kategoriler', callback_data: 'admin2_categories' }],
          [{ text: '🌐 Diller & Çeviri', callback_data: 'admin2_languages' }],
          [{ text: '🚨 Uyarılar', callback_data: 'admin2_alerts' }],
          [{ text: '🔗 Ürün Tedarikçi Bağlantıları', callback_data: 'admin_product_suppliers_list_1' }],
          [{ text: '🤖 Otomatik Alımı Düzenle', callback_data: 'admin_api_autobuy_1' }],
          [{ text: '🔙 Geri Dön', callback_data: 'admin_back_main' }]
        ]
      }
    });
  });

  // ---- SUPPLIER MANAGEMENT ----
  bot.action('admin_supplier_menu', adminMiddleware, (ctx) => {
    const suppliers = db.prepare('SELECT * FROM suppliers').all();
    let text = '🏢 <b>Kayıtlı Tedarikçiler (API)</b>\n\n';
    
    if (suppliers.length === 0) text += '<i>Hiç tedarikçi yok.</i>\n';
    suppliers.forEach(s => {
      const n = db.prepare('SELECT COUNT(*) c FROM supplier_catalogs WHERE supplier_id = ?').get(s.id).c;
      text += `<b>ID:</b> ${s.id} | <b>İsim:</b> ${s.name} | <b>Tip:</b> ${s.type}${n ? ` | katalog: ${n}` : ''}\n`;
    });

    const catalogButtons = suppliers
      .filter(s => db.prepare('SELECT COUNT(*) c FROM supplier_catalogs WHERE supplier_id = ?').get(s.id).c > 0)
      .map(s => [{ text: `📚 Katalog: ${s.name}`, callback_data: `admin2_catalog_${s.id}_1` }]);

    ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          ...catalogButtons,
          [{ text: '➕ Yeni Tedarikçi Ekle', callback_data: 'admin_add_supplier' }],
          [{ text: '🔙 Geri', callback_data: 'admin_api_menu' }]
        ]
      }
    });
  });

  bot.action('admin_add_supplier', adminMiddleware, (ctx) => {
    ctx.session = ctx.session || {}; ctx.session.adminState = 'waiting_add_supplier';
    ctx.editMessageText('➕ <b>Yeni Tedarikçi Ekle</b>\nLütfen formatı tam olarak şöyle girin:\n<code>[İSİM] | [TİP(örn: lootpaglu veya aiversexhub)] | [BASE_URL] | [API_KEY]</code>\n\nÖrnek: <code>MyLoot | lootpaglu | https://api.example.com | 123456</code>\nÖrnek: <code>AIVerse | aiversexhub | https://aiversehub.store | AK_...</code>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: 'admin_api_menu' }]] }});
  });

  // ---- PRODUCT SUPPLIER LINKING ----
  bot.action(/^admin_product_suppliers_list_(\d+)$/, adminMiddleware, (ctx) => {
    const page = parseInt(ctx.match[1] || 1, 10);
    const limit = 10;
    const offset = (page - 1) * limit;

    const products = db.prepare(`SELECT * FROM products WHERE is_active = 1 LIMIT ? OFFSET ?`).all(limit, offset);
    
    if (products.length === 0) {
      return ctx.answerCbQuery('Hiç ürün yok!', { show_alert: true });
    }

    const keyboard = products.map(p => {
      let prodName = "";
      try {
        const nameObj = JSON.parse(p.name);
        prodName = nameObj['tr'] || nameObj['en'] || "Product";
      } catch (e) {
        prodName = p.name;
      }
      // Truncate to avoid too long button text
      if (prodName.length > 40) prodName = prodName.substring(0, 37) + '...';
      return [{ text: `🔗 ${prodName} (ID: ${p.id})`, callback_data: `admin_prod_sup_${p.id}` }];
    });

    keyboard.push([{ text: '🔙 Geri', callback_data: 'admin_api_menu' }]);

    ctx.editMessageText(`🔗 <b>Hangi ürünün tedarikçi ayarlarını yapmak istiyorsunuz?</b>\n(Sayfa ${page})`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
  });

  bot.action(/^admin_prod_sup_(\d+)$/, adminMiddleware, (ctx) => {
    const pId = parseInt(ctx.match[1], 10);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(pId);
    if (!product) return ctx.answerCbQuery('Ürün bulunamadı!');

    const mapped = db.prepare('SELECT ps.*, s.name FROM product_suppliers ps JOIN suppliers s ON ps.supplier_id = s.id WHERE ps.product_id = ? ORDER BY ps.priority ASC').all(pId);
    
    let prodName = "";
    try {
      const nameObj = JSON.parse(product.name);
      prodName = nameObj['tr'] || nameObj['en'] || "Product";
    } catch (e) {
      prodName = product.name;
    }
    
    let modeStr = 'Sıralı (Öncelikli) Al';
    if (product.supplier_selection_mode === 'cheapest') modeStr = 'En Ucuzu Al';
    if (product.supplier_selection_mode === 'optimal') modeStr = 'Optimal (Parçalı) Al';
    let text = `📦 <b>Ürün:</b> ${prodName}\n⚙️ <b>Seçim Modu:</b> ${modeStr}\n\n`;
    
    if (mapped.length === 0) {
      text += `<i>Henüz bu ürüne bir tedarikçi bağlanmamış.</i>`;
    } else {
      mapped.forEach((m, i) => {
        text += `<b>${i+1}.</b> ${m.name} (Service ID: ${m.remote_service_id}) [Prio: ${m.priority}]\n`;
      });
    }

    let modeToggleTxt = '🔄 Modu Sıralı Yap';
    if (product.supplier_selection_mode === 'priority') modeToggleTxt = '🔄 Modu En Ucuz Yap';
    if (product.supplier_selection_mode === 'cheapest') modeToggleTxt = '🔄 Modu Optimal Yap';

    ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Tedarikçi Bağla', callback_data: `admin_link_sup_${pId}` }],
          [{ text: modeToggleTxt, callback_data: `admin_toggle_mode_${pId}` }],
          [{ text: '🗑 Bağlantıları Sıfırla', callback_data: `admin_reset_sup_${pId}` }],
          [{ text: '🏷️ Manuel Kademeler (Tiers)', callback_data: `admin_tiers_menu_${pId}` }],
          [{ text: '🔙 Geri', callback_data: 'admin_product_suppliers_list_1' }]
        ]
      }
    });
  });

  bot.action(/^admin_tiers_menu_(\d+)$/, adminMiddleware, (ctx) => {
    const pId = parseInt(ctx.match[1], 10);
    const mapped = db.prepare('SELECT ps.*, s.name FROM product_suppliers ps JOIN suppliers s ON ps.supplier_id = s.id WHERE ps.product_id = ? ORDER BY ps.priority ASC').all(pId);
    
    if (mapped.length === 0) return ctx.answerCbQuery('Önce tedarikçi bağlamalısınız!', { show_alert: true });

    let keyboard = mapped.map(m => {
      return [{ text: `⚙️ ${m.name} (${m.remote_service_id})`, callback_data: `admin_set_tiers_${m.id}_${pId}` }];
    });
    keyboard.push([{ text: '🔙 Geri Dön', callback_data: `admin_prod_sup_${pId}` }]);

    ctx.editMessageText(`🏷️ <b>Manuel Kademe Ayarları</b>\nLütfen kademelerini (toplu alım indirimlerini) düzenlemek istediğiniz API bağlantısını seçin:`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
  });

  bot.action(/^admin_set_tiers_(\d+)_(\d+)$/, adminMiddleware, (ctx) => {
    const psId = parseInt(ctx.match[1], 10);
    const pId = parseInt(ctx.match[2], 10);
    
    ctx.session = ctx.session || {};
    ctx.session.adminState = 'waiting_manual_tiers';
    ctx.session.tierProductSupplierId = psId;
    ctx.session.tierProductId = pId;

    const ps = db.prepare('SELECT manual_tiers FROM product_suppliers WHERE id = ?').get(psId);
    let currentTiersStr = 'Yok (Otomatik API Fiyatı)';
    if (ps && ps.manual_tiers) {
       try {
         const parsed = JSON.parse(ps.manual_tiers);
         currentTiersStr = parsed.map(t => `${t.min}-${t.max === null ? 'Sonsuz' : t.max}: ${t.price}$`).join('\n');
       } catch(e) {}
    }

    ctx.editMessageText(`🏷️ <b>Manuel Kademe Belirleme</b>\n\n📝 <b>Mevcut Kademeler:</b>\n<code>${currentTiersStr}</code>\n\nNe yapmak istersiniz?`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Yeni Kademe Ekle', callback_data: `admin_tier_add_start_${psId}` }],
          [{ text: '🗑 Tümünü Sıfırla', callback_data: `admin_tier_reset_${psId}` }],
          [{ text: '🔙 Geri Dön', callback_data: `admin_prod_sup_${pId}` }]
        ]
      }
    });
  });

  bot.action(/^admin_tier_add_start_(\d+)$/, adminMiddleware, (ctx) => {
    const psId = parseInt(ctx.match[1], 10);
    ctx.session = ctx.session || {};
    ctx.session.adminState = 'waiting_tier_min';
    ctx.session.tierProductSupplierId = psId;
    
    // Check if we are already building tiers, if not start fresh
    if (!ctx.session.buildingTiers) {
        ctx.session.buildingTiers = [];
    }

    ctx.editMessageText('🏷️ <b>Kademe Ekleme Sihirbazı (1/3)</b>\n\nBu kademenin başlangıç (minimum) adetini yazın:\n<i>Örn: 1 veya 300</i>', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: `admin_set_tiers_${psId}_${ctx.session.tierProductId}` }]] }
    });
  });

  bot.action(/^admin_tier_reset_(\d+)$/, adminMiddleware, (ctx) => {
    const psId = parseInt(ctx.match[1], 10);
    db.prepare('UPDATE product_suppliers SET manual_tiers = NULL WHERE id = ?').run(psId);
    
    ctx.answerCbQuery('Tüm kademeler sıfırlandı.', { show_alert: true });
    
    // Simulate back
    ctx.match[1] = psId;
    ctx.match[2] = ctx.session.tierProductId;
    bot.handleUpdate({
      update_id: ctx.update.update_id,
      callback_query: { ...ctx.callbackQuery, data: `admin_set_tiers_${psId}_${ctx.session.tierProductId}` }
    });
  });
  
  bot.action(/^admin_tier_finish_(\d+)$/, adminMiddleware, (ctx) => {
    const psId = parseInt(ctx.match[1], 10);
    const pId = ctx.session.tierProductId;
    
    if (ctx.session.buildingTiers && ctx.session.buildingTiers.length > 0) {
       // Fetch existing tiers to merge
       const ps = db.prepare('SELECT manual_tiers FROM product_suppliers WHERE id = ?').get(psId);
       let existing = [];
       if (ps && ps.manual_tiers) {
           try { existing = JSON.parse(ps.manual_tiers); } catch(e) {}
       }
       const newTiers = [...existing, ...ctx.session.buildingTiers];
       
       db.prepare('UPDATE product_suppliers SET manual_tiers = ? WHERE id = ?').run(JSON.stringify(newTiers), psId);
    }
    
    ctx.session.adminState = null;
    ctx.session.buildingTiers = null;
    ctx.answerCbQuery('Kademeler kaydedildi!', { show_alert: true });
    
    bot.handleUpdate({
      update_id: ctx.update.update_id,
      callback_query: { ...ctx.callbackQuery, data: `admin_set_tiers_${psId}_${pId}` }
    });
  });

  bot.action(/^admin_toggle_mode_(\d+)$/, adminMiddleware, (ctx) => {
    const pId = parseInt(ctx.match[1], 10);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(pId);
    let newMode = 'priority';
    if (product.supplier_selection_mode === 'priority') newMode = 'cheapest';
    else if (product.supplier_selection_mode === 'cheapest') newMode = 'optimal';
    else newMode = 'priority';
    
    db.prepare('UPDATE products SET supplier_selection_mode = ? WHERE id = ?').run(newMode, pId);
    ctx.answerCbQuery(`Mod ${newMode} yapıldı.`);
    
    // Simulate click to refresh
    ctx.match[1] = pId;
    bot.handleUpdate({
      update_id: ctx.update.update_id,
      callback_query: {
        id: ctx.callbackQuery.id,
        from: ctx.from,
        message: ctx.callbackQuery.message,
        chat_instance: ctx.callbackQuery.chat_instance,
        data: `admin_prod_sup_${pId}`
      }
    });
  });

  bot.action(/^admin_reset_sup_(\d+)$/, adminMiddleware, (ctx) => {
    const pId = parseInt(ctx.match[1], 10);
    db.prepare('DELETE FROM product_suppliers WHERE product_id = ?').run(pId);
    ctx.answerCbQuery('Tüm bağlantılar silindi.');
    ctx.match[1] = pId;
    bot.handleUpdate({
      update_id: ctx.update.update_id,
      callback_query: { ...ctx.callbackQuery, data: `admin_prod_sup_${pId}` }
    });
  });

  bot.action(/^admin_link_sup_(\d+)$/, adminMiddleware, (ctx) => {
    const pId = parseInt(ctx.match[1], 10);
    const suppliers = db.prepare('SELECT * FROM suppliers').all();
    
    if (suppliers.length === 0) return ctx.answerCbQuery('Hiç kayıtlı tedarikçi yok!', { show_alert: true });

    let keyboard = suppliers.map(s => {
      return [{ text: `🏢 ${s.name} (${s.type})`, callback_data: `admin_link_sup_sel_${pId}_${s.id}` }];
    });
    keyboard.push([{ text: '❌ İptal', callback_data: `admin_prod_sup_${pId}` }]);

    ctx.editMessageText(`🔗 <b>Tedarikçi Bağlama (Adım 1/2)</b>\n\nLütfen bağlamak istediğiniz tedarikçiyi seçin:`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
  });

  bot.action(/^admin_link_sup_sel_(\d+)_(\d+)$/, adminMiddleware, (ctx) => {
    const pId = parseInt(ctx.match[1], 10);
    const sId = parseInt(ctx.match[2], 10);

    // Servis ID yazma devri bitti: katalog snapshot'ında gez, dokun, bağla.
    ctx.session = ctx.session || {};
    ctx.session.cp = ctx.session.cp || {};
    ctx.session.cp.bindProductId = pId;
    ctx.session.cp.bindSid = sId;
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(sId);
    if (!supplier) return ctx.answerCbQuery('Tedarikçi yok.', { show_alert: true });

    let rows = CatalogStore.readSnapshot(sId);
    if (!rows.length) {
      return ctx.answerCbQuery('Bu tedarikçinin katalog snapshot\'ı yok — önce ⚙️ API → Katalog: ' + supplier.name + ' ile tazele.', { show_alert: true });
    }
    rows.sort((a, b) => (a.price_usd ?? 1e9) - (b.price_usd ?? 1e9));
    rows = rows.slice(0, PER_PAGE_BIND);
    ctx.session.cp.bindRows = rows.map((r) => ({ remote_service_id: r.remote_service_id, name: r.name, price_usd: r.price_usd, stock: r.stock, warranty: r.warranty }));

    const linked = new Set(db.prepare('SELECT remote_service_id FROM product_suppliers WHERE supplier_id = ?').all(sId).map((r) => r.remote_service_id));
    let text = `🔗 <b>${supplier.name}</b> → ürün #${pId}\nServise dokun (fiyata göre sıralı, ilk ${rows.length}):\n\n`;
    const keyboard = [];
    rows.forEach((r, i) => {
      const w = classifyWarranty(r.name);
      const badge = w === 'guaranteed' ? ' 🛡' : w === 'instant' ? ' ⚡' : '';
      text += `#${i + 1} <b>$${r.price_usd ?? '?'}</b> · ${r.stock ?? '?'} stok · ${String(r.name || r.remote_service_id).slice(0, 44)}${badge}${linked.has(String(r.remote_service_id)) ? ' 🔗' : ''}\n`;
      keyboard.push([{ text: `#${i + 1} ${String(r.name || r.remote_service_id).slice(0, 30)}`, callback_data: `alb_${i}` }]);
    });
    keyboard.push([{ text: '🔙 Tedarikçi seç', callback_data: `admin_link_sup_${pId}` }]);
    return ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
  });

  bot.action(/^alb_(\d+)$/, adminMiddleware, (ctx) => {
    const cp = ctx.session && ctx.session.cp;
    if (!cp || !cp.bindProductId || !cp.bindRows) return ctx.answerCbQuery('Liste düştü, baştan dene.', { show_alert: true });
    const r = cp.bindRows[parseInt(ctx.match[1], 10)];
    if (!r) return ctx.answerCbQuery('Servis bulunamadı.', { show_alert: true });
    const pId = cp.bindProductId;

    const cls = classifyWarranty(r.name);
    const kb = [
      [{ text: `✅ Bağla (${LABELS[cls] || cls})`, callback_data: `alb_go_${pId}_${r.remote_service_id}` }],
      [{ text: '🔙 Liste', callback_data: `admin_link_sup_sel_${pId}_${cp.bindSid}` }]
    ];
    return ctx.editMessageText(
      `Servis: <b>${r.name}</b>\nID <code>${r.remote_service_id}</code> · $${r.price_usd ?? '?'} · stok ${r.stock ?? '?'}\n` +
      `Otomatik garanti sınıfı: <b>${LABELS[cls] || cls}</b>`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } }
    ).catch(() => {});
  });

  bot.action(/^alb_go_(\d+)_(.+)$/, adminMiddleware, (ctx) => {
    const pId = parseInt(ctx.match[1], 10);
    const remoteId = ctx.match[2];
    const cp = ctx.session && ctx.session.cp;
    const row = cp && cp.bindRows && cp.bindRows.find((x) => String(x.remote_service_id) === String(remoteId));
    const sId = cp && cp.bindSid;
    if (!sId) return ctx.answerCbQuery('Tedarikçi seçimi düştü, tekrar dene.', { show_alert: true });

    const prio = db.prepare('SELECT COALESCE(MAX(priority),0)+1 p FROM product_suppliers WHERE product_id = ?').get(pId).p;
    const exists = db.prepare('SELECT 1 FROM product_suppliers WHERE product_id=? AND supplier_id=? AND remote_service_id=?').get(pId, sId, String(remoteId));
    if (exists) return ctx.answerCbQuery('Bu link zaten var.', { show_alert: true });

    db.prepare(`INSERT INTO product_suppliers (product_id, supplier_id, remote_service_id, priority, last_price_usd, last_stock)
                VALUES (?,?,?,?,?,?)`)
      .run(pId, sId, String(remoteId), prio, row ? row.price_usd : null, row ? row.stock : null);
    delete ctx.session.cp;
    ctx.answerCbQuery('Bağlandı ✓').catch(() => {});
    return ctx.editMessageText(`✅ Servis <code>${remoteId}</code> ürün #${pId}'e bağlandı (prio ${prio}).\nMarj/taban: Ürün detayı → Tedarikçi linkleri`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '📦 Ürün linkleri', callback_data: `admin_prod_sup_${pId}` }]] }
    }).catch(() => {});
  });

  // ---- AUTO BUY MANAGEMENT ----
  bot.action(/^admin_api_autobuy(?:_(\d+))?$/, adminMiddleware, (ctx) => {
    const page = parseInt(ctx.match[1] || 1, 10);
    const limit = 10;
    const offset = (page - 1) * limit;

    const products = db.prepare(`SELECT * FROM products WHERE is_active = 1 LIMIT ? OFFSET ?`).all(limit, offset);
    if (products.length === 0) return ctx.answerCbQuery('Hiç ürün yok!', { show_alert: true });

    const keyboard = products.map(p => {
      const status = p.auto_restock_enabled ? '✅' : '❌';
      return [{ text: `${status} ${p.name} (ID: ${p.id})`, callback_data: `admin_autobuy_prod_${p.id}` }];
    });
    keyboard.push([{ text: '🔙 Geri Dön', callback_data: 'admin_api_menu' }]);

    ctx.editMessageText('🤖 <b>Hangi ürünün otomatik stok alım ayarlarını düzenlemek istersiniz?</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
  });

  bot.action(/^admin_autobuy_prod_(\d+)$/, adminMiddleware, (ctx) => {
    const pId = parseInt(ctx.match[1], 10);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(pId);
    
    ctx.session = ctx.session || {};
    ctx.session.autobuyProductId = pId;
    ctx.session.adminState = 'waiting_autobuy_threshold';

    ctx.editMessageText(`🤖 <b>Otomatik Alımı Düzenle:</b> ${product.name}\nŞu anki Durum: ${product.auto_restock_enabled ? 'Aktif' : 'Pasif'}\nŞu anki Sınır: ${product.auto_restock_threshold || 0}\nŞu anki Alım Adeti: ${product.auto_restock_qty || 1}\n\nLütfen <b>Aktiflik (1=Açık, 0=Kapalı)</b>, <b>Sınır (Stok bu sayının altına düşünce alınır)</b> ve <b>Alınacak Adet</b> bilgilerini aralarında boşluk bırakarak yazın (Örn: 1 2 5):`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ İptal', callback_data: 'admin_api_autobuy_1' }]] }
    });
  });

}

module.exports = setupAdminApiHandlers;
