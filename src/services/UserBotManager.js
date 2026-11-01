const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const axios = require('axios');
const {
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  TELEGRAM_SESSION,
  AIVERSEXHUB_BOT_USERNAME
} = require('../config/env');

class UserBotManager {
  constructor() {
    this.client = null;
    this.isInitializing = false;
    this.isReady = false;
  }

  async init() {
    if (this.isReady || this.isInitializing) return;
    if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH || !TELEGRAM_SESSION) {
      console.log('⚠️ [UserBotManager] TELEGRAM_SESSION veya API_ID/HASH tanımlı değil. UserBot pasif kalacak.');
      return;
    }

    this.isInitializing = true;
    try {
      const stringSession = new StringSession(TELEGRAM_SESSION);
      this.client = new TelegramClient(stringSession, parseInt(TELEGRAM_API_ID, 10), TELEGRAM_API_HASH, {
        connectionRetries: 5,
      });

      await this.client.connect();
      this.isReady = await this.client.checkAuthorization();
      if (this.isReady) {
        console.log('🤖 [UserBotManager] UserBot MTProto istemcisi başarıyla bağlandı ve yetkilendirildi!');
      } else {
        console.error('❌ [UserBotManager] UserBot oturumu geçersiz veya süresi dolmuş.');
      }
    } catch (err) {
      console.error('❌ [UserBotManager] Başlatma Hatası:', err.message);
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Automate clicking buttons on Telegram Bot to buy product, then fetch products via REST API orders endpoint.
   */
  async purchaseViaTelegramBot(supplier, productName, quantity) {
    if (!this.isReady || !this.client) {
      await this.init();
      if (!this.isReady) {
        throw new Error('UserBot is not authorized or active.');
      }
    }

    const botUsername = supplier.bot_username || AIVERSEXHUB_BOT_USERNAME || 'AIVerseXBot';
    console.log(`🤖 [UserBotManager] Telegram UI üzerinden sipariş veriliyor: @${botUsername.replace('@', '')} | Ürün: ${productName} | Adet: ${quantity}`);

    try {
      const cleanBotName = botUsername.replace('@', '');

      // 1. Send /start to bot
      await this.client.sendMessage(cleanBotName, { message: '/start' });
      await new Promise(r => setTimeout(r, 300));

      // 2. Fetch recent messages to find inline keyboard buttons
      let messages = await this.client.getMessages(cleanBotName, { limit: 5 });
      if (!messages || messages.length === 0) {
        throw new Error('No response message received from target Telegram bot.');
      }

      // Find message with 'Buy Products' button or products list
      let targetMessage = messages[0];
      let buyButton = this.findButton(targetMessage, ['Buy Products', '🛒 Products', 'Products', 'Ürünler', '🛒 Ürünler']);
      
      if (buyButton) {
        await targetMessage.click({ data: buyButton.data });
        await new Promise(r => setTimeout(r, 250));
      }

      // Re-fetch messages after clicking Buy Products
      messages = await this.client.getMessages(cleanBotName, { limit: 5 });
      targetMessage = messages[0];

      // Find specific product button
      let productButton = this.findButton(targetMessage, [productName, supplier.remote_service_id]);
      if (!productButton) {
        // Search by partial name matching
        productButton = this.findButtonPartial(targetMessage, productName);
      }

      if (productButton) {
        await targetMessage.click({ data: productButton.data });
        await new Promise(r => setTimeout(r, 250));
      } else {
        console.warn(`[UserBotManager] Product button '${productName}' not found directly in first page, trying to proceed...`);
      }

      // Re-fetch messages after selecting product
      messages = await this.client.getMessages(cleanBotName, { limit: 5 });
      targetMessage = messages[0];

      // Click "Buy Now" button if present
      let buyNowBtn = this.findButton(targetMessage, ['Buy Now', '🛒 Buy Now', 'Satın Al', '✅ Buy Now', '🚩 Buy Now', '🔴 Buy Now']) || this.findButtonPartial(targetMessage, 'Buy Now');
      if (buyNowBtn) {
        await targetMessage.click({ data: buyNowBtn.data });
        await new Promise(r => setTimeout(r, 250));
      }

      // Enter quantity or click quantity button
      messages = await this.client.getMessages(cleanBotName, { limit: 5 });
      targetMessage = messages[0];

      let qtyBtn = null;
      if (targetMessage && targetMessage.replyMarkup && targetMessage.replyMarkup.rows) {
        for (const row of targetMessage.replyMarkup.rows) {
          for (const btn of row.buttons) {
            const cleanText = (btn.text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            if (cleanText === String(quantity) || cleanText === `x${quantity}`) {
              qtyBtn = btn;
              break;
            }
          }
          if (qtyBtn) break;
        }
      }
      if (qtyBtn) {
        await targetMessage.click({ data: qtyBtn.data });
        await new Promise(r => setTimeout(r, 250));
      } else {
        // Click "Custom Quantity" if exact button is not available
        let customQtyBtn = this.findButton(targetMessage, ['Custom Quantity', 'Custom Qty', '⚡ Custom Qty', '✍️ Custom Amount', 'Özel Adet', '🧪 Custom Quantity']) || this.findButtonPartial(targetMessage, 'Custom Qty') || this.findButtonPartial(targetMessage, 'Custom Quantity');
        if (customQtyBtn) {
          await targetMessage.click({ data: customQtyBtn.data });
          await new Promise(r => setTimeout(r, 200));
        }
        // Send quantity as text message
        await this.client.sendMessage(cleanBotName, { message: String(quantity) });
        await new Promise(r => setTimeout(r, 250));
      }

      // Confirmation screen: Click "Place Order"
      messages = await this.client.getMessages(cleanBotName, { limit: 5 });
      targetMessage = messages[0];

      let placeOrderBtn = this.findButton(targetMessage, ['Place Order', '💰 Place Order', 'Siparişi Onayla', 'Sipariş Ver', '🛍 Place Order']) || this.findButtonPartial(targetMessage, 'Place Order');
      if (placeOrderBtn) {
        await targetMessage.click({ data: placeOrderBtn.data });
        await new Promise(r => setTimeout(r, 400));
      } else {
        throw new Error('Could not find "Place Order" button on confirmation screen.');
      }

      console.log(`✅ [UserBotManager] Telegram UI siparişi gönderildi. Order ID yakalanıyor ve API'den teslim edilen veriler çekiliyor...`);

      // 3. Read response message to extract Order ID (e.g. TRXN1786739334NLO2QC)
      let extractedOrderId = null;
      const responseMessages = await this.client.getMessages(cleanBotName, { limit: 3 });
      for (const msg of responseMessages) {
        const text = msg.message || '';
        const match = text.match(/(?:Order ID:\s*|download\/)(TRXN[A-Za-z0-9_]+)/i) || text.match(/\b(TRXN[A-Za-z0-9_]+)\b/i);
        if (match) {
          extractedOrderId = match[1];
          console.log(`📌 [UserBotManager] Telegram mesajından Order ID yakalandı: ${extractedOrderId}`);
          break;
        }
      }

      // 4. Call REST API to get clean products array using extracted Order ID!
      const deliveredProducts = await this.fetchOrderFromApi(supplier, extractedOrderId);
      return deliveredProducts;

    } catch (err) {
      console.error(`❌ [UserBotManager] Telegram UI sipariş hatası:`, err.message);
      throw err;
    }
  }

  findButton(message, searchTexts) {
    if (!message || !message.replyMarkup || !message.replyMarkup.rows) return null;
    for (const row of message.replyMarkup.rows) {
      for (const btn of row.buttons) {
        const text = btn.text || '';
        for (const st of searchTexts) {
          if (text.toLowerCase() === String(st).toLowerCase()) {
            return btn;
          }
        }
      }
    }
    return null;
  }

  findButtonPartial(message, searchText) {
    if (!message || !message.replyMarkup || !message.replyMarkup.rows) return null;
    const cleanSearch = String(searchText).toLowerCase().replace(/[^a-z0-9]/g, '');
    const tokens = String(searchText).toLowerCase().split(/[\s_\-\/\(\)]+/).filter(t => t.length > 1);

    let bestBtn = null;
    let maxScore = 0;

    for (const row of message.replyMarkup.rows) {
      for (const btn of row.buttons) {
        const text = (btn.text || '').toLowerCase();
        const cleanText = text.replace(/[^a-z0-9]/g, '');

        if (cleanText && (cleanText.includes(cleanSearch) || cleanSearch.includes(cleanText))) {
          return btn; // Direct match
        }

        let score = 0;
        for (const token of tokens) {
          if (text.includes(token)) score++;
        }

        if (score > maxScore) {
          maxScore = score;
          bestBtn = btn;
        }
      }
    }
    return maxScore >= 1 ? bestBtn : null;
  }

  async fetchOrderFromApi(supplier, orderId = null) {
    const client = axios.create({
      baseURL: supplier.base_url,
      headers: {
        'X-API-Key': supplier.api_key,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        // If orderId is captured from Telegram, try direct GET /api/v1/order/{orderId} first!
        if (orderId) {
          try {
            const response = await client.get(`/api/v1/order/${orderId}`);
            const orderObj = response.data.order || response.data;
            const delivered = orderObj.delivered_products || orderObj.products || [];
            if (delivered.length > 0) {
              console.log(`✅ [UserBotManager] API Order ID (${orderId}) üzerinden ${delivered.length} adet teslimat çekildi!`);
              return {
                success: true,
                order_id: orderId,
                products: delivered
              };
            }
          } catch (e) {
            console.warn(`[UserBotManager] Direct GET /api/v1/order/${orderId} failed, trying latest order fallback...`);
          }
        }

        // Fallback: GET /api/v1/orders?limit=1
        const response = await client.get('/api/v1/orders?limit=1');
        const orders = response.data.orders || [];
        if (orders.length > 0) {
          const latestOrder = orders[0];
          const delivered = latestOrder.delivered_products || latestOrder.products || [];
          if (delivered.length > 0) {
            console.log(`✅ [UserBotManager] API En Son Sipariş (${latestOrder.order_id}) üzerinden ${delivered.length} adet teslimat çekildi!`);
            return {
              success: true,
              order_id: latestOrder.order_id,
              products: delivered
            };
          }
        }
      } catch (err) {
        console.error(`[UserBotManager] fetchOrderFromApi Deneme ${attempt} Hatası:`, err.message);
      }
      await new Promise(r => setTimeout(r, 400));
    }
    throw new Error('Sipariş Telegram üzerinden verildi ancak API teslimat verisi çekilemedi.');
  }
}

const userBotManager = new UserBotManager();
module.exports = userBotManager;
