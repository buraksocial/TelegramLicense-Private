const { db } = require('../db');
const { t } = require('../utils/i18n');

// Yardımcı Fonksiyon: Kullanıcı dilini getir
function getUserLang(userId) {
  const user = db.prepare('SELECT lang FROM users WHERE id = ?').get(userId);
  return user?.lang || 'en';
}

function setupStartCommand(bot) {
  bot.start((ctx) => {
    const user = ctx.from;
    const payload = ctx.payload; // e.g. ref_123456
    let referredBy = null;
    
    if (payload && payload.startsWith('ref_')) {
      const refId = parseInt(payload.replace('ref_', ''), 10);
      if (!isNaN(refId) && refId !== user.id) {
        // Check if referring user exists
        const refUser = db.prepare('SELECT id FROM users WHERE id = ?').get(refId);
        if (refUser) {
          referredBy = refId;
        }
      }
    }
    
    // Check if user already exists
    const existingUser = db.prepare('SELECT id, referred_by FROM users WHERE id = ?').get(user.id);

    // Kullanıcıyı veritabanına ekle veya güncelle (Zaten varsa adını vb günceller)
    // If user is new and referredBy is valid, set referred_by
    if (!existingUser) {
      const insertUser = db.prepare(`
        INSERT INTO users (id, username, first_name, referred_by) 
        VALUES (?, ?, ?, ?)
      `);
      insertUser.run(user.id, user.username || '', user.first_name || '', referredBy);
    } else {
      const updateUser = db.prepare(`
        UPDATE users SET username = ?, first_name = ? WHERE id = ?
      `);
      updateUser.run(user.username || '', user.first_name || '', user.id);
    }

    // State sıfırlama (Herhangi bir işlemde kaldıysa başa döner)
    if (ctx.session) ctx.session.state = null;

    const lang = getUserLang(user.id);
    
    ctx.reply(t(lang, 'welcome_msg', { name: user.first_name || '' }), {
      reply_markup: {
        inline_keyboard: [
          [{ text: t(lang, 'btn_products') || '🛒 Products', callback_data: 'menu_products' }],
          [
            { text: t(lang, 'btn_profile') || '👤 Profile', callback_data: 'menu_profile' },
            { text: t(lang, 'btn_wallet') || '💼 Wallet', callback_data: 'menu_wallet' }
          ],
          [
            { text: t(lang, 'btn_rank') || '🏆 Rank & VIP', callback_data: 'menu_rank' },
            { text: t(lang, 'btn_referral') || '🔗 Referral', callback_data: 'menu_referral' }
          ],
          [
            { text: t(lang, 'btn_help') || '❓ Help', callback_data: 'menu_help' },
            { text: t(lang, 'btn_language') || '🌐 Language', callback_data: 'menu_language' }
          ]
        ]
      }
    });
  });

  // Dil Seçimi Menüsü
  bot.action('menu_language', (ctx) => {
    const lang = getUserLang(ctx.from.id);
    ctx.editMessageText(t(lang, 'choose_language'), {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🇬🇧 English', callback_data: 'setlang_en' }, { text: '🇹🇷 Türkçe', callback_data: 'setlang_tr' }],
          [{ text: '🇷🇺 Русский', callback_data: 'setlang_ru' }, { text: '🇨🇳 中文', callback_data: 'setlang_zh' }],
          [{ text: '🇮🇳 हिन्दी', callback_data: 'setlang_hi' }, { text: '🇩🇪 Deutsch', callback_data: 'setlang_de' }],
          [{ text: '🇫🇷 Français', callback_data: 'setlang_fr' }],
          [{ text: t(lang, 'btn_main_menu'), callback_data: 'main_menu' }]
        ]
      }
    });
  });

  // Dili Ayarlama
  bot.action(/^setlang_(en|tr|ru|zh|hi|de|fr)$/, (ctx) => {
    const newLang = ctx.match[1];
    db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(newLang, ctx.from.id);
    ctx.answerCbQuery(t(newLang, 'lang_selected'), { show_alert: true });
    
    // Ana menüyü yeni dilde göster
    bot.handleUpdate({
      update_id: ctx.update.update_id,
      message: {
        message_id: ctx.callbackQuery.message.message_id,
        from: ctx.from,
        chat: ctx.callbackQuery.message.chat,
        date: Math.floor(Date.now() / 1000),
        text: '/start',
        entities: [{ offset: 0, length: 6, type: 'bot_command' }]
      }
    });
  });

  bot.action('check_sub', (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const alertMsg = t(lang, 'sub_verified') || '✅ Verified!';
    // Force sub middleware üzerinden başarıyla geçtiği için buraya ulaşabiliyor.
    ctx.answerCbQuery(alertMsg, { show_alert: true });
    
    // Start komutunu tetiklemiş gibi davranıp ana menüyü yeniden çıkar
    ctx.deleteMessage().catch(() => {});
    
    // Basitçe start fonksiyonunu manuel tetikleyelim
    bot.handleUpdate({
      update_id: ctx.update.update_id,
      message: {
        message_id: ctx.callbackQuery.message.message_id,
        from: ctx.from,
        chat: ctx.callbackQuery.message.chat,
        date: Math.floor(Date.now() / 1000),
        text: '/start',
        entities: [{ offset: 0, length: 6, type: 'bot_command' }]
      }
    });
  });
}

module.exports = setupStartCommand;
