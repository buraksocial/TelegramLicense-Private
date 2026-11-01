const { db } = require('../db');
const { calculateSignature, checkTransaction } = require('../services/binance');
const { t } = require('../utils/i18n');
const { BINANCE_PAY_ID } = require('../config/env');
const { sendOrderLog, sendWalletTopUpLog } = require('../utils/logger');

// Yardımcı Fonksiyon: Ürün ismini dile göre al
function getProductName(product, lang) {
  try {
    const parsed = JSON.parse(product.name);
    return parsed[lang] || parsed['en'] || parsed['tr'] || product.name;
  } catch (e) {
    return product.name; // Eski formatta (JSON olmayan) düz metin olarak eklendiyse
  }
}

function getUserLang(userId) {
  const user = db.prepare('SELECT lang FROM users WHERE id = ?').get(userId);
  return user?.lang || 'en';
}

function getUserRank(userId) {
  const user = db.prepare('SELECT total_purchases FROM users WHERE id = ?').get(userId);
  if (!user) return null;

  return db.prepare('SELECT * FROM ranks WHERE min_purchases <= ? ORDER BY min_purchases DESC LIMIT 1').get(user.total_purchases || 0);
}

function getReservationFee(userId) {
  const userRow = db.prepare('SELECT custom_reservation_fee FROM users WHERE id = ?').get(userId);
  if (userRow && userRow.custom_reservation_fee !== null) {
    return parseFloat(userRow.custom_reservation_fee);
  }
  const feeRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('reservation_fee');
  return feeRow ? parseFloat(feeRow.value) : 0.10;
}

function getUserUnitPrice(userId, product) {
  // 1. Check Pricing Group
  const userGroup = db.prepare('SELECT g.id, g.discount_percent FROM user_pricing_groups u JOIN pricing_groups g ON u.group_id = g.id WHERE u.user_id = ?').get(userId);
  if (userGroup) {
    const groupProduct = db.prepare('SELECT price FROM pricing_group_products WHERE group_id = ? AND product_id = ?').get(userGroup.id, product.id);
    if (groupProduct) return groupProduct.price;
    if (userGroup.discount_percent > 0) return product.price * (1 - (userGroup.discount_percent / 100));
    return product.price; // If group has no specific product or discount, return original
  }

  // 2. Check Rank
  const rank = getUserRank(userId);
  let price = product.price;

  if (rank) {
    const rankProduct = db.prepare('SELECT special_price FROM rank_special_prices WHERE rank_id = ? AND product_id = ?').get(rank.id, product.id);
    if (rankProduct) {
      price = rankProduct.special_price;
    } else if (rank.discount_percent > 0) {
      price = product.price * (1 - (rank.discount_percent / 100));
    }
  }

  // 3. Check Promo Discount
  const isActualReseller = db.prepare('SELECT * FROM resellers WHERE user_id = ?').get(userId);
  const userRow = db.prepare('SELECT reseller_promo_ban FROM users WHERE id = ?').get(userId);

  if (!isActualReseller && (!userRow || userRow.reseller_promo_ban === 0)) {
    // Only normal users can use promos
    const activePromo = db.prepare(`
      SELECT p.value 
      FROM promo_codes p 
      JOIN user_promos up ON p.id = up.promo_id 
      WHERE up.user_id = ? 
        AND p.type = 'discount' 
        AND (up.expires_at IS NULL OR up.expires_at > CURRENT_TIMESTAMP)
      ORDER BY p.value DESC LIMIT 1
    `).get(userId);

    if (activePromo && activePromo.value > 0) {
      price = price * (1 - (activePromo.value / 100));
    }
  }

  return price;
}

function calculateTotalPrice(userId, product, qty) {
  let unitPrice = getUserUnitPrice(userId, product);

  // Bulk discounts apply only if no custom pricing group and no rank override?
  // User didn't specify bulk discounts relation to Rank. I'll keep bulk discounts on top of unitPrice if they don't have a group.
  const userGroup = db.prepare('SELECT * FROM user_pricing_groups WHERE user_id = ?').get(userId);
  if (!userGroup) {
    const bestDiscount = db.prepare('SELECT * FROM product_bulk_discounts WHERE product_id = ? AND min_qty <= ? ORDER BY min_qty DESC LIMIT 1').get(product.id, qty);
    if (bestDiscount) {
      if (bestDiscount.fixed_price !== null && bestDiscount.fixed_price !== undefined) {
        unitPrice = bestDiscount.fixed_price;
      } else if (bestDiscount.discount_percent > 0) {
        unitPrice = unitPrice * (1 - (bestDiscount.discount_percent / 100));
      }
    }
  }
  return unitPrice * qty;
}

function setupUserHandlers(bot) {
  bot.command('promo', (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
      return ctx.reply('Kullanım: /promo <KOD>');
    }
    const codeStr = args[1].trim();
    // Check if the user is an actual reseller
    const isActualReseller = db.prepare('SELECT * FROM resellers WHERE user_id = ?').get(ctx.from.id);
    if (isActualReseller) {
      return ctx.reply('❌ Bayiler promosyon kodu kullanamazlar.');
    }

    // Check reseller_promo_ban for sub-users
    const userRow = db.prepare('SELECT reseller_promo_ban FROM users WHERE id = ?').get(ctx.from.id);
    if (userRow && userRow.reseller_promo_ban === 1) {
      return ctx.reply('❌ Promosyon kodu kullanamazsınız. Bayiden gelen bakiyenizi henüz tüketmediniz.');
    }

    // Check code
    const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ? COLLATE NOCASE').get(codeStr);
    if (!promo) return ctx.reply('❌ Geçersiz promo kodu.');
    if (promo.expires_at && new Date(promo.expires_at + 'Z') < new Date()) return ctx.reply('❌ Bu kodun süresi dolmuş.');

    // Check if used
    const used = db.prepare('SELECT * FROM user_promos WHERE user_id = ? AND promo_id = ?').get(ctx.from.id, promo.id);
    if (used) return ctx.reply('❌ Bu kodu zaten kullandınız.');

    const usageCount = db.prepare('SELECT COUNT(*) as c FROM user_promos WHERE promo_id = ?').get(promo.id).c;
    if (usageCount >= promo.max_uses) return ctx.reply('❌ Bu kodun kullanım sınırı dolmuş.');

    // Apply
    const expiresAt = promo.expiry_hours ? new Date(Date.now() + promo.expiry_hours * 3600000).toISOString() : null;

    if (promo.type === 'balance') {
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(promo.value, ctx.from.id);
      db.prepare('INSERT INTO user_promos (user_id, promo_id, expires_at) VALUES (?, ?, ?)').run(ctx.from.id, promo.id, expiresAt);
      sendWalletTopUpLog(ctx.telegram, ctx.from.id, promo.value);
      return ctx.reply(`✅ Tebrikler! Hesabınıza ${promo.value}$ bakiye eklendi.`);
    } else {
      db.prepare('INSERT INTO user_promos (user_id, promo_id, expires_at) VALUES (?, ?, ?)').run(ctx.from.id, promo.id, expiresAt);
      const timeTxt = promo.expiry_hours ? `${promo.expiry_hours} saat boyunca ` : '';
      return ctx.reply(`✅ Tebrikler! ${timeTxt}%${promo.value} indirim kazandınız!`);
    }
  });

  bot.action('menu_products', async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const products = db.prepare('SELECT * FROM products WHERE is_active = 1').all();

    if (products.length === 0) {
      return ctx.answerCbQuery(t(lang, 'no_active_products'), { show_alert: true });
    }

    const buttons = products.map(p => {
      const stockCount = db.prepare('SELECT COUNT(*) as count FROM stocks WHERE product_id = ? AND is_sold = 0').get(p.id).count;
      const localizedName = getProductName(p, lang);
      let displayPrice = getUserUnitPrice(ctx.from.id, p);
      let btnText = '';
      if (stockCount === 0) {
        const reservePrice = displayPrice * 1.10;
        btnText = `${localizedName} - ${reservePrice.toFixed(2)}$ ${t(lang, 'reserve_btn_label')}`;
      } else {
        btnText = `${localizedName} - ${displayPrice.toFixed(2)}$ (${t(lang, 'stock_lbl')}: ${stockCount})`;
      }
      return [{ text: btnText, callback_data: `buy_${p.id}` }];
    });

    ctx.editMessageText(t(lang, 'products_list_msg'), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          ...buttons,
          [{ text: t(lang, 'btn_main_menu'), callback_data: 'main_menu' }]
        ]
      }
    });
  });

  bot.action('main_menu', async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    if (ctx.session) ctx.session.state = null;
    ctx.editMessageText(t(lang, 'menu_choose_action'), {
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
    }).catch(e => { });
  });

  bot.action('menu_profile', async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.from.id);
    const purchases = db.prepare('SELECT COUNT(*) as count FROM transactions WHERE user_id = ? AND status = ?').get(ctx.from.id, 'SUCCESS').count;
    const activeReservations = db.prepare(`SELECT SUM(fulfilled_qty) as fulfilled, SUM(qty) as total FROM reservations WHERE user_id = ? AND status IN ('PENDING', 'PARTIAL')`).get(ctx.from.id);
    const totalSpentRow = db.prepare("SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND status = 'SUCCESS'").get(ctx.from.id);
    const totalSpent = (totalSpentRow && totalSpentRow.total) ? totalSpentRow.total.toFixed(4) : '0.0000';

    const joinedDateStr = user.joined_at ? user.joined_at.split(' ')[0] : 'N/A';
    const currentDate = new Date().toUTCString();
    
    let resStr = "";
    if (activeReservations && activeReservations.total > 0) {
      resStr = `\n` + t(lang, 'profile_active_reservations', { fulfilled: activeReservations.fulfilled || 0, total: activeReservations.total });
    }

    let profileText = `${t(lang, 'profile_title')}\n\n`;
    profileText += `ID: <code>${ctx.from.id}</code>\n`;
    profileText += `${t(lang, 'profile_joined_date')}: ${joinedDateStr}\n`;
    profileText += `${t(lang, 'profile_current_date')}: ${currentDate}\n\n`;
    profileText += `<b>${t(lang, 'profile_financials')}</b>\n`;
    profileText += `${t(lang, 'profile_wallet_balance')}: ${(user.balance || 0).toFixed(4)} USDT\n`;
    const totalDeposit = (parseFloat(totalSpent) + (user.balance || 0)).toFixed(4);
    profileText += `${t(lang, 'profile_total_deposit')}: ${totalDeposit} USDT\n`;
    profileText += `<b>${t(lang, 'total_spent_lbl')}</b>$${totalSpent}\n`;
    profileText += `\n${t(lang, 'profile_successful_purchases')}: ${purchases}`;
    profileText += resStr;

    ctx.editMessageText(profileText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: t(lang, 'btn_my_orders') || '📦 My Orders', callback_data: 'my_past_orders_1' }],
          [{ text: t(lang, 'btn_my_reservations') || '⏳ My Reservations', callback_data: 'my_reservations_1' }],
          [{ text: t(lang, 'btn_main_menu') || '🔙 Main Menu', callback_data: 'main_menu' }]
        ]
      }
    });
  });

  bot.action(/^my_past_orders_(\d+)$/, async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const page = parseInt(ctx.match[1], 10) || 1;
    const limit = 5;
    const offset = (page - 1) * limit;

    const totalCountRow = db.prepare('SELECT COUNT(*) as count FROM orders WHERE user_id = ?').get(ctx.from.id);
    const totalCount = totalCountRow ? totalCountRow.count : 0;

    if (totalCount === 0) {
      return ctx.answerCbQuery(t(lang, 'no_past_orders') || 'No past orders found.', { show_alert: true });
    }

    const orders = db.prepare('SELECT o.id, p.name, o.qty, o.created_at FROM orders o JOIN products p ON o.product_id = p.id WHERE o.user_id = ? ORDER BY o.id DESC LIMIT ? OFFSET ?').all(ctx.from.id, limit, offset);

    const buttons = orders.map(o => {
      let prodName = "";
      try {
        const nameObj = JSON.parse(o.name);
        prodName = nameObj[lang] || nameObj['en'] || "Product";
      } catch (e) { prodName = o.name; }
      if (prodName.length > 25) prodName = prodName.substring(0, 22) + '...';
      return [{ text: `📦 Order ID: ${o.id} - ${prodName} (${o.qty} pcs)`, callback_data: `view_order_${o.id}` }];
    });

    const navButtons = [];
    if (page > 1) navButtons.push({ text: t(lang, 'btn_prev'), callback_data: `my_past_orders_${page - 1}` });
    if (offset + limit < totalCount) navButtons.push({ text: t(lang, 'btn_next'), callback_data: `my_past_orders_${page + 1}` });
    if (navButtons.length > 0) buttons.push(navButtons);
    buttons.push([{ text: t(lang, 'btn_profile_back') || '🔙 Profile', callback_data: 'menu_profile' }]);

    ctx.editMessageText(t(lang, 'my_orders_title') + ` (${t(lang, 'page_lbl') || 'Page'} ${page})`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }).catch(() => {});
  });

  bot.action(/^view_order_(\d+)$/, async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const orderId = parseInt(ctx.match[1], 10);
    const order = db.prepare('SELECT o.id, p.name, o.qty, o.created_at, o.delivered_data FROM orders o JOIN products p ON o.product_id = p.id WHERE o.id = ? AND o.user_id = ?').get(orderId, ctx.from.id);
    
    if (!order) return ctx.answerCbQuery('Order not found!', { show_alert: true });

    let prodName = "";
    try {
      const nameObj = JSON.parse(order.name);
      prodName = nameObj[lang] || nameObj['en'] || "Product";
    } catch (e) { prodName = order.name; }

    let dataStr = "";
    try {
      if (order.delivered_data) {
        const dataArr = JSON.parse(order.delivered_data);
        dataStr = dataArr.join('\n');
      } else {
        dataStr = "No data found.";
      }
    } catch (e) { dataStr = "Data format error."; }

    // If data is too long, we might need to send a txt file anyway to avoid Telegram character limits
    const textMsg = t(lang, 'order_detail', { name: prodName, qty: order.qty, date: order.created_at, data: dataStr });
    
    if (textMsg.length > 3500) {
       ctx.editMessageText(t(lang, 'order_detail', { name: prodName, qty: order.qty, date: order.created_at, data: "Data is too large, sending as a file..." }), {
         parse_mode: 'HTML',
         reply_markup: { inline_keyboard: [[{ text: t(lang, 'btn_back') || '🔙 Back', callback_data: 'my_past_orders_1' }]] }
       });
       const axios = require('axios');
       const FormData = require('form-data');
       const { BOT_TOKEN } = require('../config/env');
       const form = new FormData();
       form.append('chat_id', ctx.from.id);
       form.append('document', Buffer.from(dataStr, 'utf-8'), { filename: `order_${orderId}.txt`, contentType: 'text/plain' });
       return axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, form, { headers: form.getHeaders(), timeout: 15000 }).catch(e => console.error(e));
    }

    ctx.editMessageText(textMsg, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: t(lang, 'btn_back') || '🔙 Back', callback_data: 'my_past_orders_1' }]] }
    }).catch(() => {});
  });

  bot.action(/^my_reservations_(\d+)$/, async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const page = parseInt(ctx.match[1], 10) || 1;
    const limit = 5;
    const offset = (page - 1) * limit;

    const totalCountRow = db.prepare('SELECT COUNT(*) as count FROM reservations WHERE user_id = ?').get(ctx.from.id);
    const totalCount = totalCountRow ? totalCountRow.count : 0;

    if (totalCount === 0) {
      return ctx.answerCbQuery(t(lang, 'no_reservations') || 'No reservations found.', { show_alert: true });
    }

    const reservations = db.prepare('SELECT r.id, p.name, r.qty, r.fulfilled_qty, r.status, r.created_at FROM reservations r JOIN products p ON r.product_id = p.id WHERE r.user_id = ? ORDER BY r.id DESC LIMIT ? OFFSET ?').all(ctx.from.id, limit, offset);

    const buttons = reservations.map(r => {
      let prodName = "";
      try {
        const nameObj = JSON.parse(r.name);
        prodName = nameObj[lang] || nameObj['en'] || "Product";
      } catch (e) { prodName = r.name; }
      if (prodName.length > 25) prodName = prodName.substring(0, 22) + '...';
      return [{ text: `⏳ Res ID: ${r.id} - ${prodName} (${r.fulfilled_qty}/${r.qty})`, callback_data: `view_res_${r.id}` }];
    });

    const navButtons = [];
    if (page > 1) navButtons.push({ text: t(lang, 'btn_prev'), callback_data: `my_reservations_${page - 1}` });
    if (offset + limit < totalCount) navButtons.push({ text: t(lang, 'btn_next'), callback_data: `my_reservations_${page + 1}` });
    if (navButtons.length > 0) buttons.push(navButtons);
    buttons.push([{ text: t(lang, 'btn_profile_back') || '🔙 Profile', callback_data: 'menu_profile' }]);

    ctx.editMessageText(t(lang, 'my_reservations_title') + ` (${t(lang, 'page_lbl') || 'Page'} ${page})`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }).catch(() => {});
  });

  bot.action(/^view_res_(\d+)$/, async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const resId = parseInt(ctx.match[1], 10);
    const res = db.prepare('SELECT r.id, p.name, r.qty, r.fulfilled_qty, r.status, r.created_at, r.delivered_data FROM reservations r JOIN products p ON r.product_id = p.id WHERE r.id = ? AND r.user_id = ?').get(resId, ctx.from.id);
    
    if (!res) return ctx.answerCbQuery('Reservation not found!', { show_alert: true });

    let prodName = "";
    try {
      const nameObj = JSON.parse(res.name);
      prodName = nameObj[lang] || nameObj['en'] || "Product";
    } catch (e) { prodName = res.name; }

    let dataStr = "";
    try {
      if (res.delivered_data) {
        const dataArr = JSON.parse(res.delivered_data);
        dataStr = dataArr.join('\n');
      } else {
        dataStr = "No delivery yet.";
      }
    } catch (e) { dataStr = "Data format error."; }

    const textMsg = t(lang, 'reservation_detail', { name: prodName, status: res.status, fulfilled: res.fulfilled_qty, qty: res.qty, date: res.created_at, data: dataStr });
    
    if (textMsg.length > 3500) {
       ctx.editMessageText(t(lang, 'reservation_detail', { name: prodName, status: res.status, fulfilled: res.fulfilled_qty, qty: res.qty, date: res.created_at, data: "Data is too large, sending as a file..." }), {
         parse_mode: 'HTML',
         reply_markup: { inline_keyboard: [[{ text: t(lang, 'btn_back') || '🔙 Back', callback_data: 'my_reservations_1' }]] }
       });
       const axios = require('axios');
       const FormData = require('form-data');
       const { BOT_TOKEN } = require('../config/env');
       const form = new FormData();
       form.append('chat_id', ctx.from.id);
       form.append('document', Buffer.from(dataStr, 'utf-8'), { filename: `reservation_${resId}.txt`, contentType: 'text/plain' });
       return axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, form, { headers: form.getHeaders(), timeout: 15000 }).catch(e => console.error(e));
    }

    ctx.editMessageText(textMsg, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: t(lang, 'btn_back') || '🔙 Back', callback_data: 'my_reservations_1' }]] }
    }).catch(() => {});
  });

  bot.action('menu_wallet', async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(ctx.from.id);
    const balance = user ? (user.balance || 0).toFixed(2) : '0.00';

    ctx.editMessageText(`💼 <b>Wallet Balance:</b> ${balance}$`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: t(lang, 'btn_main_menu') || '🔙 Main Menu', callback_data: 'main_menu' }]
        ]
      }
    });
  });

  bot.action('menu_referral', async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const botUsername = ctx.botInfo.username;
    const refLink = `https://t.me/${botUsername}?start=ref_${ctx.from.id}`;

    ctx.editMessageText(`🔗 <b>Your Referral Link:</b>\n<code>${refLink}</code>\n\nInvite your friends and earn rewards when they make a purchase!`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: t(lang, 'btn_main_menu') || '🔙 Main Menu', callback_data: 'main_menu' }]
        ]
      }
    });
  });

  const showRankMenu = async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const user = db.prepare('SELECT total_purchases FROM users WHERE id = ?').get(ctx.from.id);
    const totalPurchases = user ? (user.total_purchases || 0) : 0;

    const userRank = db.prepare('SELECT * FROM ranks WHERE min_purchases <= ? ORDER BY min_purchases DESC LIMIT 1').get(totalPurchases);
    const nextRank = db.prepare('SELECT * FROM ranks WHERE min_purchases > ? ORDER BY min_purchases ASC LIMIT 1').get(totalPurchases);

    if (ctx.callbackQuery) {
      ctx.answerCbQuery('Generating Rank Card...').catch(() => { });
      try {
        await ctx.deleteMessage();
      } catch (e) {
        // ignore
      }
    }

    const { generateRankImage } = require('../utils/canvas');
    const imageBuffer = await generateRankImage(lang, userRank, nextRank, totalPurchases);

    try {
      console.log('Sending rank image...');
      const fs = require('fs');
      const axios = require('axios');
      const FormData = require('form-data');
      const { BOT_TOKEN } = require('../config/env');

      const form = new FormData();
      form.append('chat_id', ctx.from.id);
      form.append('photo', imageBuffer, { filename: 'rank.png', contentType: 'image/png' });
      form.append('caption', t(lang, 'rank_system_caption', { total: totalPurchases }));
      form.append('parse_mode', 'HTML');
      form.append('reply_markup', JSON.stringify({
        inline_keyboard: [
          [{ text: t(lang, 'btn_main_menu') || '🔙 Main Menu', callback_data: 'main_menu_new' }]
        ]
      }));

      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, form, {
        headers: form.getHeaders(),
        timeout: 10000 // 10 saniye timeout
      });
      console.log('Successfully sent Rank image!');
    } catch (e) {
      console.error('Error generating or sending rank image:', e);
      ctx.reply('❌ Error generating rank image.').catch(() => { });
    }
  };

  bot.action('menu_rank', showRankMenu);
  bot.command('rank', showRankMenu);

  bot.action('main_menu_new', async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    if (ctx.session) ctx.session.state = null;
    ctx.reply(t(lang, 'menu_choose_action'), {
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
    try {
      ctx.deleteMessage(); // Delete the photo message
    } catch (e) { }
  });

  bot.action('menu_help', async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    ctx.editMessageText(t(lang, 'help_msg'), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: t(lang, 'btn_main_menu'), callback_data: 'main_menu' }]
        ]
      }
    });
  });

  // Ürün Seçildi -> Adet Sor
  bot.action(/^buy_(\d+)$/, async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const productId = parseInt(ctx.match[1], 10);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);

    if (!product) {
      return ctx.answerCbQuery(t(lang, 'product_not_found'), { show_alert: true });
    }

    const stockCount = db.prepare('SELECT COUNT(*) as count FROM stocks WHERE product_id = ? AND is_sold = 0').get(productId).count;

    if (stockCount === 0) {
      ctx.session = ctx.session || {};
      ctx.session.isReservation = true;
      let quantities = [1, 5, 10, 20, 50, 100];
      const qtyButtons = [];
      for (let i = 0; i < quantities.length; i += 2) {
        const row = [];
        row.push({ text: `${quantities[i]}`, callback_data: `qty_${productId}_${quantities[i]}` });
        if (i + 1 < quantities.length) {
          row.push({ text: `${quantities[i + 1]}`, callback_data: `qty_${productId}_${quantities[i + 1]}` });
        }
        qtyButtons.push(row);
      }
      qtyButtons.push([{ text: t(lang, 'btn_custom_quantity'), callback_data: `customqty_${productId}` }]);
      qtyButtons.push([{ text: t(lang, 'btn_cancel'), callback_data: 'main_menu' }]);

      const localizedName = getProductName(product, lang);
      const displayPrice = (getUserUnitPrice(ctx.from.id, product) * 1.10).toFixed(2);
      const msg = t(lang, 'reserve_prompt_msg', { name: localizedName, price: displayPrice });

      return ctx.editMessageText(msg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: qtyButtons
        }
      });
    } else {
      ctx.session = ctx.session || {};
      ctx.session.isReservation = false;
    }

    // Seçilebilir adetler (stok sayısına göre filtrelenir)
    let quantities = [1, 5, 10, 20, 50, 100];
    quantities = quantities.filter(q => q < stockCount);
    quantities.push(stockCount); // En büyük stok sayısını sonuna ekle (örnek: 98 ise 100 yerine 98 yazar)

    // Satır satır butonlar (2 sütun)
    const qtyButtons = [];
    for (let i = 0; i < quantities.length; i += 2) {
      const row = [];
      row.push({ text: `${quantities[i]}`, callback_data: `qty_${productId}_${quantities[i]}` });
      if (i + 1 < quantities.length) {
        row.push({ text: `${quantities[i + 1]}`, callback_data: `qty_${productId}_${quantities[i + 1]}` });
      }
      qtyButtons.push(row);
    }

    // Özel adet butonu
    qtyButtons.push([{ text: t(lang, 'btn_custom_quantity'), callback_data: `customqty_${productId}` }]);
    qtyButtons.push([{ text: t(lang, 'btn_cancel'), callback_data: 'main_menu' }]);

    const localizedName = getProductName(product, lang);
    const displayPrice = getUserUnitPrice(ctx.from.id, product).toFixed(2);
    const msg = t(lang, 'choose_quantity_msg', { name: localizedName, price: displayPrice, stock: stockCount });

    ctx.editMessageText(msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: qtyButtons
      }
    });
  });

  // Hazır adet seçimi
  bot.action(/^qty_(\d+)_(\d+)$/, async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const productId = parseInt(ctx.match[1], 10);
    const qty = parseInt(ctx.match[2], 10);

    await startPaymentProcess(ctx, lang, productId, qty);
  });

  // Özel Adet İsteme
  bot.action(/^customqty_(\d+)$/, async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const productId = parseInt(ctx.match[1], 10);

    const stockCount = db.prepare('SELECT COUNT(*) as count FROM stocks WHERE product_id = ? AND is_sold = 0').get(productId).count;

    ctx.session = ctx.session || {};
    ctx.session.state = 'waiting_custom_quantity';
    ctx.session.productId = productId;
    ctx.session.maxStock = stockCount;

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    const maxAllowed = (ctx.session.isReservation || product.auto_restock_enabled) ? 10000 : stockCount;

    ctx.editMessageText(t(lang, 'enter_custom_quantity', { max: maxAllowed }), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: t(lang, 'btn_cancel'), callback_data: `buy_${productId}` }]
        ]
      }
    });
  });

  bot.action(/^partialres_(\d+)_(\d+)$/, async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const productId = parseInt(ctx.match[1], 10);
    const qty = parseInt(ctx.match[2], 10);
    ctx.session = ctx.session || {};
    ctx.session.isPartialReservation = true;
    await startPaymentProcess(ctx, lang, productId, qty, true);
  });

  bot.action(/^bid_yes_([\d.]+)$/, async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const bidPrice = parseFloat(ctx.match[1]);
    if (!ctx.session || !ctx.session.bidPendingData) return ctx.answerCbQuery('Session expired', { show_alert: true });
    
    ctx.session.bidConfirmed = true;
    ctx.session.bidPrice = bidPrice;
    
    const { productId, qty } = ctx.session.bidPendingData;
    ctx.session.bidPendingData = null;
    await startPaymentProcess(ctx, lang, productId, qty, true); // skip prompt since we already agreed
  });

  bot.action(/^bid_no_([\d.]+)$/, async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    const currentPrice = parseFloat(ctx.match[1]);
    if (!ctx.session || !ctx.session.bidPendingData) return ctx.answerCbQuery('Session expired', { show_alert: true });
    
    ctx.session.bidConfirmed = true;
    ctx.session.bidPrice = currentPrice;
    
    const { productId, qty } = ctx.session.bidPendingData;
    ctx.session.bidPendingData = null;
    await startPaymentProcess(ctx, lang, productId, qty, true);
  });

  // Ortak ödeme başlatma fonksiyonu
  async function startPaymentProcess(ctx, lang, productId, qty, skipPartialPrompt = false) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    const stockCount = db.prepare('SELECT COUNT(*) as count FROM stocks WHERE product_id = ? AND is_sold = 0').get(productId).count;

    ctx.session = ctx.session || {};
    const isReservation = ctx.session.isReservation === true;
    const isPartialReservation = ctx.session.isPartialReservation === true;

    // Fetch reservation fee
    const reservationFee = getReservationFee(ctx.from.id);
      
    const SupplierManager = require('../services/SupplierManager');
    let apiStock = 0;
    let missingQuantity = Math.max(0, qty - stockCount);
    if (missingQuantity > 0 && product.auto_restock_enabled) {
        apiStock = await SupplierManager.getAffordableQuantity(product, missingQuantity);
    }
    const trueMissing = Math.max(0, missingQuantity - apiStock);
    ctx.session.trueMissing = trueMissing;

    let maxAllowed = (isReservation || product.auto_restock_enabled) ? 10000 : stockCount;

    if (qty > maxAllowed) {
      const msg = t(lang, 'not_enough_stock', { max: maxAllowed });
      if (ctx.callbackQuery) {
        return ctx.answerCbQuery(msg, { show_alert: true }).catch(console.error);
      } else {
        return ctx.reply(msg).catch(console.error);
      }
    }

    // Bidding Logic
    if ((isReservation || isPartialReservation) && !ctx.session.bidConfirmed) {
      const highestBidRow = db.prepare("SELECT MAX(unit_price) as maxBid FROM reservations WHERE product_id = ? AND status IN ('PENDING', 'PARTIAL')").get(productId);
      const highestBid = highestBidRow && highestBidRow.maxBid ? highestBidRow.maxBid : 0;
      
      let baseUnitPrice = 0;
      if (isReservation) {
          baseUnitPrice = (calculateTotalPrice(ctx.from.id, product, 1) * 1.10) + reservationFee;
      } else {
          baseUnitPrice = calculateTotalPrice(ctx.from.id, product, 1) + reservationFee;
      }

      if (highestBid >= baseUnitPrice) {
         const newBid = (highestBid + 0.01).toFixed(2);
         const currentBid = baseUnitPrice.toFixed(2);
         const promptText = t(lang, 'reserve_bid_prompt', { highestBid: highestBid.toFixed(2), newBid });
         const btnYes = t(lang, 'btn_bid_yes', { newBid }) || `Yes`;
         const btnNo = t(lang, 'btn_bid_no', { currentBid }) || `No`;
         
         ctx.session.bidPendingData = { productId, qty };
         
         const keyboard = [
            [{ text: btnYes, callback_data: `bid_yes_${newBid}` }],
            [{ text: btnNo, callback_data: `bid_no_${currentBid}` }],
            [{ text: t(lang, 'btn_cancel') || '❌ Cancel', callback_data: 'main_menu' }]
         ];
         
         const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
         if (ctx.callbackQuery) {
            return ctx.editMessageText(promptText, opts).catch(console.error);
         } else {
            return ctx.reply(promptText, opts).catch(console.error);
         }
      }
    }

    if (!isReservation && !isPartialReservation && qty > stockCount && !skipPartialPrompt) {
      const missing = qty - stockCount;
      const feeTotal = trueMissing * reservationFee;

      const priceAvailable = calculateTotalPrice(ctx.from.id, product, stockCount);
      let priceMissing = calculateTotalPrice(ctx.from.id, product, missing);
      // Removed 10% markup for partial reservations, only flat fee applies as requested
      priceMissing = priceMissing + feeTotal;

      const grandTotal = (priceAvailable + priceMissing).toFixed(2);
      const localizedName = getProductName(product, lang);

      const promptText = t(lang, 'partial_reserve_prompt', {
        name: localizedName,
        stock: stockCount,
        qty: qty,
        missing: missing,
        fee: reservationFee.toFixed(2),
        totalFee: feeTotal.toFixed(2),
        totalAvailable: priceAvailable.toFixed(2),
        totalReserved: priceMissing.toFixed(2),
        grandTotal: grandTotal
      }) || `📦 <b>${localizedName}</b>\n\nWe only have <b>${stockCount}</b> in stock. You asked for <b>${qty}</b>.\nDo you want to reserve the remaining ${missing}? (Fee: +${feeTotal.toFixed(2)}$)\n\n💰 Total for ${stockCount} available: ${priceAvailable.toFixed(2)}$\n💰 Total for ${missing} reserved: ${priceMissing.toFixed(2)}$\n\n<b>Total Price: ${grandTotal}$</b>`;

      const btnReserve = t(lang, 'btn_reserve_remaining', { grandTotal }) || `📦 Reserve Remaining`;
      const btnBuyStock = t(lang, 'btn_buy_only_available', { stock: stockCount, totalAvailable: priceAvailable.toFixed(2) }) || `🛒 Buy Only ${stockCount}`;
      const btnCancel = t(lang, 'btn_cancel') || '❌ Cancel';

      const keyboard = [
        [{ text: btnReserve, callback_data: `partialres_${productId}_${qty}` }]
      ];
      if (stockCount > 0) {
        keyboard.push([{ text: btnBuyStock, callback_data: `buy_${productId}_${stockCount}` }]);
      }
      keyboard.push([{ text: btnCancel, callback_data: 'main_menu' }]);

      const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
      if (ctx.callbackQuery) {
        return ctx.editMessageText(promptText, opts).catch(console.error);
      } else {
        return ctx.reply(promptText, opts).catch(console.error);
      }
    }

    let totalPrice = 0;
    if (isReservation) {
      if (ctx.session.bidConfirmed && ctx.session.bidPrice) {
         totalPrice = ctx.session.bidPrice * qty;
      } else {
         let basePrice = calculateTotalPrice(ctx.from.id, product, qty);
         totalPrice = (basePrice * 1.10) + (trueMissing * reservationFee);
      }
    } else if (isPartialReservation) {
      const missing = qty - stockCount;
      const priceAvailable = calculateTotalPrice(ctx.from.id, product, stockCount);
      let priceMissing = 0;
      if (ctx.session.bidConfirmed && ctx.session.bidPrice) {
         priceMissing = ctx.session.bidPrice * missing;
      } else {
         priceMissing = calculateTotalPrice(ctx.from.id, product, missing) + (trueMissing * reservationFee);
      }
      totalPrice = priceAvailable + priceMissing;
    } else {
      totalPrice = calculateTotalPrice(ctx.from.id, product, qty);
    }

    // Checkout Selection
    ctx.session = ctx.session || {};
    ctx.session.productId = productId;
    ctx.session.productQuantity = qty;
    ctx.session.productPrice = totalPrice;

    const localizedName = getProductName(product, lang);
    const msg = `🛍 <b>Selected Product:</b> ${localizedName}\n📦 <b>Quantity:</b> ${qty}\n\nPlease select a payment method:`;

    const keyboard = [
      [{ text: '💳 Binance Pay', callback_data: `pay_binance` }],
      [{ text: `💼 Wallet Balance`, callback_data: `pay_wallet` }],
      [{ text: t(lang, 'btn_cancel') || '❌ Cancel', callback_data: 'main_menu' }]
    ];

    if (ctx.callbackQuery) {
      ctx.editMessageText(msg, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    } else {
      ctx.reply(msg, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  }

  bot.action('pay_binance', async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    if (!ctx.session || !ctx.session.productId) return;

    ctx.session.state = 'waiting_txid';
    const msg = t(lang, 'payment_info_msg', {
      name: '', // We can simplify or re-fetch name
      quantity: ctx.session.productQuantity,
      totalPrice: ctx.session.productPrice,
      payId: BINANCE_PAY_ID
    });

    ctx.editMessageText(msg, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: t(lang, 'btn_cancel') || '❌ Cancel', callback_data: 'main_menu' }]] }
    });
  });

  bot.action('pay_wallet', async (ctx) => {
    const lang = getUserLang(ctx.from.id);
    if (!ctx.session || !ctx.session.productId) return;

    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(ctx.from.id);
    if (!user || user.balance < ctx.session.productPrice) {
      return ctx.answerCbQuery(`❌ Insufficient balance! (Balance: ${user ? user.balance : 0}$)`, { show_alert: true });
    }

    ctx.answerCbQuery('Processing payment...');
    ctx.editMessageText('⏳ İşleminiz yapılıyor, lütfen bekleyin...', { parse_mode: 'HTML' });

    // Deduct balance
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(ctx.session.productPrice, ctx.from.id);

    // Continue with checkout using a mock TXID or specialized logic
    const mockTxid = 'WALLET_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    await processSuccessfulPayment(ctx, lang, mockTxid, ctx.session.productPrice);
  });
  bot.on('text', async (ctx, next) => {
    const lang = getUserLang(ctx.from.id);

    if (ctx.session && ctx.session.state === 'waiting_custom_quantity') {
      const input = parseInt(ctx.message.text.trim(), 10);

      if (isNaN(input) || input <= 0) {
        return ctx.reply(t(lang, 'invalid_quantity'));
      }

      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(ctx.session.productId);
      const maxAllowed = (ctx.session.isReservation || product.auto_restock_enabled) ? 10000 : ctx.session.maxStock;

      if (input > maxAllowed) {
        return ctx.reply(t(lang, 'not_enough_stock', { max: maxAllowed }));
      }

      // Geçerliyse ödemeye geç
      await startPaymentProcess(ctx, lang, ctx.session.productId, input);

    } else if (ctx.session && ctx.session.state === 'waiting_txid') {
      const txid = ctx.message.text.trim();
      const productId = ctx.session.productId;
      const qty = ctx.session.productQuantity;
      const totalPrice = ctx.session.productPrice;

      // 1. Double-spend Koruması
      const existingTx = db.prepare('SELECT * FROM transactions WHERE txid = ?').get(txid);
      if (existingTx) {
        return ctx.reply(t(lang, 'txid_used'));
      }

      ctx.reply(t(lang, 'payment_checking'));

      // 2. Binance API ile TXID sorgusu
      const paymentInfo = await checkTransaction(txid);

      if (!paymentInfo || paymentInfo.status !== 'SUCCESS') {
        return ctx.reply(t(lang, 'payment_not_found'));
      }

      // 3. Tutar Doğrulaması (Toplam tutar)
      if (paymentInfo.amount < totalPrice) {
        return ctx.reply(t(lang, 'insufficient_payment', { required: totalPrice, sent: paymentInfo.amount }));
      }

      await processSuccessfulPayment(ctx, lang, txid, paymentInfo.amount);
    }
  });

  async function processSuccessfulPayment(ctx, lang, txid, paidAmount) {
    const productId = ctx.session.productId;
    let qty = ctx.session.productQuantity;
    const totalPrice = ctx.session.productPrice;

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    let localStockCount = db.prepare('SELECT COUNT(*) as count FROM stocks WHERE product_id = ? AND is_sold = 0').get(productId).count;

    // IF PARTIAL RESERVATION
    if (ctx.session && ctx.session.isPartialReservation) {
      const { getUsdTryRate } = require('../utils/currency');
      const tryRate = await getUsdTryRate();
      const costUsd = product.cost_usd || 0;

      const qtyToDeliver = localStockCount;
      const qtyToReserve = qty - localStockCount;

      // Fetch reservation fee
      const reservationFee = getReservationFee(ctx.from.id);

      // We split the paid amount proportionally (approximate) or exactly
      const tm = ctx.session.trueMissing !== undefined ? ctx.session.trueMissing : qtyToReserve;
        const totalFee = tm * reservationFee;
        const baseUnitPrice = calculateTotalPrice(ctx.from.id, product, 1);
        let reserveUnitPrice = ctx.session.bidConfirmed && ctx.session.bidPrice ? ctx.session.bidPrice : (baseUnitPrice + (qtyToReserve > 0 ? (totalFee / qtyToReserve) : 0));
      let reservedTotalCost = costUsd * qtyToReserve;
      let reservedTotalSell = reserveUnitPrice * qtyToReserve;
      let reservedProfit = reservedTotalSell - reservedTotalCost;

      // Save to reservations for the missing part
      db.prepare('INSERT INTO reservations (user_id, product_id, qty, fulfilled_qty, cost_usd, sell_usd, profit_usd, cost_try, sell_try, profit_try, unit_price, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        ctx.from.id, productId, qtyToReserve, 0, costUsd, reservedTotalSell, reservedProfit, costUsd * tryRate, reservedTotalSell * tryRate, reservedProfit * tryRate, reserveUnitPrice, 'PENDING'
      );

      ctx.session.isPartialReservation = false;

      // Now we override qty so the rest of the function delivers the instant stock
      qty = qtyToDeliver;

      // Note: paidAmount covers BOTH. The rest of the function will record the full paidAmount in transactions and orders. 
      // This is acceptable as the user paid it now. The reservation table handles the delivery tracking.
    }

    // IF RESERVATION
    if (ctx.session && ctx.session.isReservation) {
      const { getUsdTryRate } = require('../utils/currency');
      const tryRate = await getUsdTryRate();
      const costUsd = product.cost_usd || 0;
      const profitUsd = paidAmount - (costUsd * qty);
      const reservationFee = getReservationFee(ctx.from.id);

      const tm = ctx.session.trueMissing !== undefined ? ctx.session.trueMissing : qty;
        const totalFee = tm * reservationFee;
        const baseUnitPrice = calculateTotalPrice(ctx.from.id, product, 1) * 1.10;
        let reserveUnitPrice = ctx.session.bidConfirmed && ctx.session.bidPrice ? ctx.session.bidPrice : (baseUnitPrice + (qty > 0 ? (totalFee / qty) : 0));
      
      // Save to reservations
      db.prepare('INSERT INTO reservations (user_id, product_id, qty, fulfilled_qty, cost_usd, sell_usd, profit_usd, cost_try, sell_try, profit_try, unit_price, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        ctx.from.id, productId, qty, 0, costUsd, paidAmount, profitUsd,
        costUsd * qty * tryRate, paidAmount * tryRate, profitUsd * tryRate, reserveUnitPrice, 'PENDING'
      );

      // Save to transactions
      db.prepare('INSERT INTO transactions (txid, user_id, product_id, amount, status, amount_try) VALUES (?, ?, ?, ?, ?, ?)').run(
        txid, ctx.from.id, productId, paidAmount, 'SUCCESS', paidAmount * tryRate
      );

      // Save to orders so it appears in stats
      db.prepare('INSERT INTO orders (user_id, product_id, qty, cost_usd, sell_usd, profit_usd, cost_try, sell_try, profit_try) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        ctx.from.id, productId, qty, costUsd, paidAmount, profitUsd,
        costUsd * qty * tryRate, paidAmount * tryRate, profitUsd * tryRate
      );

      // Update stats
      db.prepare('UPDATE users SET total_purchases = total_purchases + ? WHERE id = ?').run(qty, ctx.from.id);

      ctx.session.state = null;
      ctx.session.isReservation = false;

      sendOrderLog(ctx.telegram, true, ctx.from.id, product ? getProductName(product, 'en') : productId, qty);

      return ctx.reply(t(lang, 'reserve_success_msg', { qty }), { parse_mode: 'HTML' });
    }

    // Otomatik Stok Tamamlama
    const threshold = product.auto_restock_threshold || 0;
    // We check if product has mapped suppliers instead of relying solely on api_service_id.
    // But auto_restock_enabled should be true.
    if ((localStockCount - qty <= threshold) && product.auto_restock_enabled) {
      try {
        const needed = qty - localStockCount;
        const buyQty = Math.max(product.auto_restock_qty || 1, needed > 0 ? needed : 0);

        if (needed > 0) {
          ctx.reply(t(lang, 'auto_restock_searching') || "🔄 İsteğiniz üzerine yeni stoklar inceleniyor ve sisteme dahil ediliyor. Lütfen bekleyin...");
        }

        const SupplierManager = require('../services/SupplierManager');
        const orderResult = await SupplierManager.placeOrder(product, buyQty);
        const apiResponse = orderResult.result;

        if (apiResponse && (apiResponse.success || (apiResponse.products && apiResponse.products.length > 0)) && apiResponse.products) {
          const insertStock = db.prepare('INSERT INTO stocks (product_id, data, is_sold) VALUES (?, ?, 0)');
          const insertMany = db.transaction((prods) => {
            for (const p of prods) insertStock.run(productId, p);
          });
          insertMany(apiResponse.products);
          localStockCount += apiResponse.products.length;
        } else {
          console.error("Supplier failed:", apiResponse);
          if (needed > 0) {
            return ctx.reply(t(lang, 'auto_restock_api_error') || "❌ Stok tedarik edilirken API tarafında bir sorun oluştu. Lütfen yöneticiye ulaşın. Ödemeniz güvendedir.");
          }
        }
      } catch (err) {
        console.error("Auto restock error:", err.message);
        if (qty - localStockCount > 0) {
          if (err.message === "OUT_OF_STOCK_OR_BALANCE") {
            return ctx.reply(t(lang, 'not_enough_stock', { max: localStockCount }) || "❌ Yetersiz stok!");
          }
          return ctx.reply(t(lang, 'auto_restock_system_error') || "❌ Sistem otomatik stok alımında hata verdi. Lütfen yöneticiyle iletişime geçiniz. Ödemeniz güvendedir.");
        }
      }
    }

    const { getUsdTryRate } = require('../utils/currency');
    const tryRate = await getUsdTryRate();

    // 4. Stoğu Teslim Et ve İşlemi Kaydet (Çoklu ürün için loop)
    const deliverStock = db.transaction(() => {
      // İstenilen miktarda stok çek ve kilitle
      const stocks = db.prepare('SELECT * FROM stocks WHERE product_id = ? AND is_sold = 0 LIMIT ?').all(productId, qty);

      if (stocks.length < qty) {
        throw new Error('OUT_OF_STOCK');
      }

      const deliveryData = [];
      for (const stock of stocks) {
        db.prepare('UPDATE stocks SET is_sold = 1 WHERE id = ?').run(stock.id);
        deliveryData.push(stock.data);
      }

      // İşlemi kaydet
      db.prepare('INSERT INTO transactions (txid, user_id, product_id, amount, status, amount_try) VALUES (?, ?, ?, ?, ?, ?)').run(
        txid, ctx.from.id, productId, paidAmount, 'SUCCESS', paidAmount * tryRate
      );

      return deliveryData;
    });

    try {
      const deliveredStocks = deliverStock();
      ctx.session.state = null; // İşlem bitti

      // 5. Update Stats and Orders
      const costUsd = product.cost_usd || 0;
      const profitUsd = paidAmount - (costUsd * qty);
      db.prepare('INSERT INTO orders (user_id, product_id, qty, cost_usd, sell_usd, profit_usd, cost_try, sell_try, profit_try, delivered_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        ctx.from.id, productId, qty, costUsd, paidAmount, profitUsd,
        costUsd * qty * tryRate, paidAmount * tryRate, profitUsd * tryRate,
        JSON.stringify(deliveredStocks)
      );

      // Update total purchases for Rank system
      db.prepare('UPDATE users SET total_purchases = total_purchases + ? WHERE id = ?').run(qty, ctx.from.id);

      // 6. Referral System Logic
      const buyerUser = db.prepare('SELECT referred_by FROM users WHERE id = ?').get(ctx.from.id);
      if (buyerUser && buyerUser.referred_by) {
        const isReferrerReseller = db.prepare('SELECT * FROM reseller_users WHERE user_id = ?').get(buyerUser.referred_by);
        if (!isReferrerReseller) {

          // Check if active discount promo was used during this purchase
          const usedPromo = db.prepare(`
              SELECT p.id 
              FROM promo_codes p 
              JOIN user_promos up ON p.id = up.promo_id 
              WHERE up.user_id = ? AND p.type = 'discount' 
                AND (up.expires_at IS NULL OR up.expires_at > CURRENT_TIMESTAMP)
            `).get(ctx.from.id);

          if (!usedPromo) { // No discount promo used, proceed with referral reward
            const refEnabled = db.prepare('SELECT value FROM settings WHERE key = ?').get('referral_enabled');
            if (refEnabled && refEnabled.value === '1') {
              const refType = db.prepare('SELECT value FROM settings WHERE key = ?').get('referral_reward_type');
              const refValueStr = db.prepare('SELECT value FROM settings WHERE key = ?').get('referral_reward_value');
              const refVal = parseFloat(refValueStr ? refValueStr.value : '0');
              if (refVal > 0) {
                let reward = 0;
                if (refType && refType.value === 'percent') {
                  reward = paidAmount * (refVal / 100);
                } else {
                  reward = refVal * qty; // Fixed amount per item
                }
                if (reward > 0) {
                  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(reward, buyerUser.referred_by);
                  sendWalletTopUpLog(ctx.telegram, buyerUser.referred_by, reward);
                  ctx.telegram.sendMessage(buyerUser.referred_by, `🎉 <b>Referans Kazancı!</b>\nBir alt üyeniz alışveriş yaptı ve cüzdanınıza <b>${reward.toFixed(2)}$</b> eklendi!`, { parse_mode: 'HTML' }).catch(e => { });
                }
              }
            }
          }
        }
      }

      // 7. Promo Ban Clearance (Reseller Logic)
      const currentUserData = db.prepare('SELECT balance, reseller_promo_ban FROM users WHERE id = ?').get(ctx.from.id);
      if (currentUserData && currentUserData.reseller_promo_ban === 1) {
        const cheapestProduct = db.prepare('SELECT MIN(price) as minPrice FROM products').get();
        if (cheapestProduct && currentUserData.balance < cheapestProduct.minPrice) {
          db.prepare('UPDATE users SET reseller_promo_ban = 0 WHERE id = ?').run(ctx.from.id);
        }
      }

      ctx.reply(t(lang, 'payment_success'), { parse_mode: 'HTML' });

      // Verileri birleştir (örneğin her hesabı/kodu \n---\n ile ayır)
      const combinedData = deliveredStocks.join('\n------------------------\n');
      let isFile = combinedData.length > 3500 || deliveredStocks.length > 10;
      let fileDataStr = isFile ? (lang === 'tr' ? 'Ekli dosyayı kontrol ediniz. ⬇️' : 'Please check the attached file. ⬇️') : `<code>${combinedData}</code>`;

      ctx.reply(t(lang, 'delivery_info', { data: fileDataStr }), { parse_mode: 'HTML' })
        .then(() => {
          if (isFile) {
            const axios = require('axios');
            const FormData = require('form-data');
            const { BOT_TOKEN } = require('../config/env');
            
            const form = new FormData();
            form.append('chat_id', ctx.from.id);
            form.append('document', Buffer.from(combinedData, 'utf-8'), { filename: 'products.txt', contentType: 'text/plain' });
            
            return axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, form, {
              headers: form.getHeaders(),
              timeout: 15000
            });
          }
        })
        .catch(err => { console.error("Delivery info send error:", err) });

      sendOrderLog(ctx.telegram, false, ctx.from.id, product ? getProductName(product, 'en') : productId, qty);

    } catch (err) {
      if (err.message === 'OUT_OF_STOCK') {
        ctx.reply(t(lang, 'stock_finished_during_payment'));
      } else {
        console.error(err);
        ctx.reply(t(lang, 'db_error'));
      }
    }

  }
}

module.exports = setupUserHandlers;
