const { db } = require('../db');
const { t } = require('../utils/i18n');
const { sendWalletTopUpLog } = require('../utils/logger');

function getUserLang(userId) {
  const user = db.prepare('SELECT lang FROM users WHERE id = ?').get(userId);
  return user?.lang || 'en';
}

function setupResellerHandlers(bot) {
  const resellerMiddleware = (ctx, next) => {
    const reseller = db.prepare('SELECT * FROM resellers WHERE user_id = ?').get(ctx.from.id);
    if (reseller) {
      ctx.resellerData = reseller;
      return next();
    }
  };

  const showResellerPanel = (ctx) => {
    const lang = getUserLang(ctx.from.id);
    if (ctx.session) ctx.session.resellerState = null;
    
    const limitStr = ctx.resellerData.balance_limit === 0 ? 'Unlimited / Sınırsız' : `${ctx.resellerData.balance_limit.toFixed(2)}$`;
    const title = t(lang, 'reseller_panel_title', { limit: limitStr });

    ctx.reply(title, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: t(lang, 'reseller_add_sub'), callback_data: 'reseller_add_user' }],
          [{ text: t(lang, 'reseller_add_balance'), callback_data: 'reseller_add_bal' }],
          [{ text: t(lang, 'reseller_pricing'), callback_data: 'reseller_pricing' }],
          [{ text: t(lang, 'reseller_cancel'), callback_data: 'reseller_cancel' }]
        ]
      }
    });
  };

  bot.command('bayi', resellerMiddleware, showResellerPanel);
  bot.command('reseller', resellerMiddleware, showResellerPanel);

  bot.action('reseller_cancel', resellerMiddleware, (ctx) => {
    const lang = getUserLang(ctx.from.id);
    if (ctx.session) ctx.session.resellerState = null;
    ctx.editMessageText(t(lang, 'reseller_cancelled'));
  });

  bot.action('reseller_add_user', resellerMiddleware, (ctx) => {
    const lang = getUserLang(ctx.from.id);
    ctx.session = ctx.session || {};
    ctx.session.resellerState = 'waiting_subuser_id';
    ctx.editMessageText(t(lang, 'reseller_enter_uid'), { parse_mode: 'HTML' });
  });

  bot.action('reseller_add_bal', resellerMiddleware, (ctx) => {
    const lang = getUserLang(ctx.from.id);
    ctx.session = ctx.session || {};
    ctx.session.resellerState = 'waiting_bal_uid';
    ctx.editMessageText(t(lang, 'reseller_enter_bal_uid'), { parse_mode: 'HTML' });
  });

  bot.action('reseller_pricing', resellerMiddleware, (ctx) => {
    const lang = getUserLang(ctx.from.id);
    ctx.session = ctx.session || {};
    ctx.editMessageText(t(lang, 'reseller_pricing_soon'), { parse_mode: 'HTML' });
  });

  bot.on('message', (ctx, next) => {
    const reseller = db.prepare('SELECT * FROM resellers WHERE user_id = ?').get(ctx.from.id);
    if (!reseller) return next();
    ctx.resellerData = reseller;

    if (!ctx.session || !ctx.session.resellerState) return next();
    const state = ctx.session.resellerState;
    const lang = getUserLang(ctx.from.id);

    if (state === 'waiting_subuser_id') {
      const uid = parseInt(ctx.message.text.trim(), 10);
      if (isNaN(uid)) return ctx.reply(t(lang, 'reseller_invalid_uid') || '❌');
      
      try {
        db.prepare('INSERT INTO reseller_users (reseller_id, user_id) VALUES (?, ?)').run(ctx.resellerData.id, uid);
        ctx.reply(t(lang, 'reseller_sub_added', { uid }));
      } catch (e) {
        ctx.reply(t(lang, 'reseller_error', { msg: e.message }) || `❌ Hata: ${e.message}`);
      }
      ctx.session.resellerState = null;
    } 
    else if (state === 'waiting_bal_uid') {
      const uid = parseInt(ctx.message.text.trim(), 10);
      if (isNaN(uid)) return ctx.reply(t(lang, 'reseller_invalid_uid') || '❌');
      
      // Ensure user is in their network
      const isSub = db.prepare('SELECT * FROM reseller_users WHERE reseller_id = ? AND user_id = ?').get(ctx.resellerData.id, uid);
      if (!isSub) return ctx.reply(t(lang, 'reseller_user_not_in_network') || '❌ This user is not in your network.');

      ctx.session.resellerBalUid = uid;
      ctx.session.resellerState = 'waiting_bal_amount';
      const limitStr = ctx.resellerData.balance_limit === 0 ? 'Unlimited' : ctx.resellerData.balance_limit.toString();
      ctx.reply(t(lang, 'reseller_enter_bal_amount', { uid, limit: limitStr }));
    }
    else if (state === 'waiting_bal_amount') {
      const amount = require('../utils/money').parseMoney(ctx.message.text);
      if (amount === null || amount <= 0) return ctx.reply(t(lang, 'reseller_error', { msg: "Invalid amount" }) || '❌');
      
      if (ctx.resellerData.balance_limit !== 0 && amount > ctx.resellerData.balance_limit) {
         return ctx.reply(t(lang, 'reseller_limit_exceeded', { limit: ctx.resellerData.balance_limit }));
      }

      try {
        // Apply balance
        db.prepare('UPDATE users SET balance = balance + ?, reseller_promo_ban = 1 WHERE id = ?').run(amount, ctx.session.resellerBalUid);
        
        sendWalletTopUpLog(ctx.telegram, ctx.session.resellerBalUid, amount);

        // Decrease limit if not unlimited
        if (ctx.resellerData.balance_limit !== 0) {
           db.prepare('UPDATE resellers SET balance_limit = balance_limit - ? WHERE id = ?').run(amount, ctx.resellerData.id);
        }
        ctx.reply(t(lang, 'reseller_bal_added', { amount, uid: ctx.session.resellerBalUid }));
      } catch (e) {
        ctx.reply(t(lang, 'reseller_error', { msg: e.message }) || `❌ Hata: ${e.message}`);
      }
      ctx.session.resellerState = null;
    }
    else {
      return next();
    }
  });
}

module.exports = setupResellerHandlers;
