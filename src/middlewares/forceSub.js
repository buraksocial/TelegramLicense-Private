const { FORCE_CHANNEL, FORCE_GROUP } = require('../config/env');

async function checkMembership(ctx, next) {
  try {
    // Sadece kanal veya grup ID'si tanımlanmışsa çalışır
    if (!FORCE_CHANNEL && !FORCE_GROUP) return next();

    // Sadece mesaj veya callback query geldiğinde çalışsın
    if (!ctx.from) return next();

    const userId = ctx.from.id;
    const channelsToCheck = [FORCE_CHANNEL, FORCE_GROUP].filter(Boolean);
    let notJoined = [];

    for (const channel of channelsToCheck) {
      try {
        const member = await ctx.telegram.getChatMember(channel, userId);
        // Eğer kullanıcı üye değilse durumu left veya kicked döner
        if (member.status === 'left' || member.status === 'kicked') {
          notJoined.push(channel);
        }
      } catch (err) {
        console.error(`${channel} kontrol edilemedi:`, err.message);
        // Bot grupta admin değilse üyelik çekemez, şimdilik geçiyoruz.
      }
    }

    // Eğer üye olmadığı kanal/grup varsa uyarı gönder
    if (notJoined.length > 0) {
      // Dil verisini çek
      const { db } = require('../db');
      const { t } = require('../utils/i18n');
      let lang = 'en';
      try {
        const u = db.prepare('SELECT lang FROM users WHERE id = ?').get(userId);
        if (u) lang = u.lang;
      } catch (e) {}

      const btnJoinText = t(lang, 'btn_join') || 'Join';
      const btnCheckText = t(lang, 'btn_check_sub') || '✅ Check';
      const warningMessage = t(lang, 'force_sub_warning') || '⚠️ To use the bot, you must join the following channels:';

      const buttons = notJoined.map(channel => {
        return [{ text: `${channel} ${btnJoinText}`, url: `https://t.me/${channel.replace('@', '')}` }];
      });
      buttons.push([{ text: btnCheckText, callback_data: 'check_sub' }]);

      // Callback query ise ve daha önce mesaj attıysak alert verebiliriz veya editMessage yapabiliriz.
      // Mesaj silinmiş olabilir, o yüzden catch ile güvenli yanıt atıyoruz.
      
      if (ctx.callbackQuery) {
        return ctx.reply(warningMessage, {
          reply_markup: { inline_keyboard: buttons }
        }).catch(() => {});
      } else {
        return ctx.reply(warningMessage, {
          reply_markup: { inline_keyboard: buttons }
        });
      }
    }

    return next();
  } catch (err) {
    console.error('ForceSub Hatası:', err);
    return next();
  }
}

module.exports = checkMembership;
