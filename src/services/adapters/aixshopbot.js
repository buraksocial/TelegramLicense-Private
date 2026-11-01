const axios = require('axios');
const userBotManager = require('../UserBotManager');

const cache = {
  balance: { value: null, expires: 0 },
  products: { value: null, expires: 0 },
  prices: {},
  pendingPricePromises: {},
  pendingBalancePromise: null,
  pendingProductsPromise: null
};

const CACHE_TTL = 30000; // 30 seconds

function getApiClient(supplier) {
  if (!supplier.api_key) return null;
  return axios.create({
    baseURL: supplier.base_url || 'https://aixshop.store',
    headers: {
      'X-API-Key': supplier.api_key,
      'Content-Type': 'application/json'
    },
    timeout: 10000
  });
}

async function waitForButton(client, botName, exacts, partials, maxRetries = 8, delayMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    const msgs = await client.getMessages(botName, { limit: 5 });
    for (const m of msgs) {
      let b = null;
      if (exacts && exacts.length > 0) b = userBotManager.findButton(m, exacts);
      if (!b && partials && partials.length > 0) {
        for (const p of partials) {
          b = userBotManager.findButtonPartial(m, p);
          if (b) break;
        }
      }
      if (b) return { msg: m, btn: b };
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

async function getClient() {
  if (!userBotManager.isReady) {
    await userBotManager.init();
  }
  if (!userBotManager.isReady) {
    throw new Error('UserBot is not authorized or active.');
  }
  return userBotManager.client;
}

function getBotUsername(supplier) {
  return (supplier.bot_username || 'Aixshopbot').replace('@', '');
}

async function getBalance(supplier) {
  if (Date.now() < cache.balance.expires) return cache.balance.value;

  if (cache.pendingBalancePromise) return cache.pendingBalancePromise;

  cache.pendingBalancePromise = (async () => {
    const apiClient = getApiClient(supplier);
    if (apiClient) {
      try {
        const response = await apiClient.get('/api/v1/me');
        const val = response.data.wallet_balance !== undefined ? parseFloat(response.data.wallet_balance) : Infinity;
        cache.balance.value = val;
        cache.balance.expires = Date.now() + CACHE_TTL;
        return val;
      } catch (err) {
        console.warn(`AixShop API getBalance failed: ${err.message}, falling back to manual mode`);
      }
    }

    try {
      const client = await getClient();
      const botName = getBotUsername(supplier);

      // 1. Send /start
      await client.sendMessage(botName, { message: '/start' });
      await new Promise(r => setTimeout(r, 2500));

      // 2. Click My Wallet
      let messages = await client.getMessages(botName, { limit: 5 });
      let targetMessage = messages[0]; // fallback
      let myWalletBtn = null;
      for (const msg of messages) {
        myWalletBtn = userBotManager.findButton(msg, ['My Wallet', 'Wallet', 'Cüzdanım']) || userBotManager.findButtonPartial(msg, 'My Wallet');
        if (myWalletBtn) { targetMessage = msg; break; }
      }

      if (myWalletBtn) {
        await targetMessage.click({ data: myWalletBtn.data });
        await new Promise(r => setTimeout(r, 2500));
      }

      // 3. Read Wallet Response
      messages = await client.getMessages(botName, { limit: 5 });
      let walletMsg = '';
      for (const msg of messages) {
        if (msg.message && (msg.message.includes('USDT') || msg.message.includes('Balance') || msg.message.includes('User Profile'))) {
          walletMsg = msg.message;
          break;
        }
      }
      if (!walletMsg) walletMsg = messages[0].message || '';

      // Crypto Balance: 4.60 USDT
      const match = walletMsg.match(/Crypto Balance:\s*([\d.]+)\s*USDT/i);
      const val = match ? parseFloat(match[1]) : 0;

      cache.balance.value = val;
      cache.balance.expires = Date.now() + CACHE_TTL;
      return val;
    } catch (error) {
      cache.pendingBalancePromise = null;
      // Cache the error state for 30 seconds to prevent spamming /start
      cache.balance = { value: 0, expires: Date.now() + 30000 };
      console.error(`AixShopBotAdapter getBalance Error:`, error.message);
      throw error;
    } finally {
      cache.pendingBalancePromise = null;
    }
  })();

  return cache.pendingBalancePromise;
}

async function getPrice(supplier) {
  const serviceStr = String(supplier.remote_service_id);
  const apiClient = getApiClient(supplier);

  if (apiClient) {
    try {
      let productList = cache.products.value;
      if (Date.now() >= cache.products.expires) {
        if (!cache.pendingProductsPromise) {
          cache.pendingProductsPromise = apiClient.get('/api/v1/products').then(res => {
            const list = res.data.services || res.data;
            cache.products.value = list;
            cache.products.expires = Date.now() + CACHE_TTL;
            return list;
          }).finally(() => {
            cache.pendingProductsPromise = null;
          });
        }
        productList = await cache.pendingProductsPromise;
      }

      const targetProduct = productList.find(p => String(p.service_id) === serviceStr || String(p.id) === serviceStr);
      if (targetProduct && targetProduct.price !== undefined) {
        let stock = Infinity;
        if (targetProduct.stock !== undefined) stock = parseInt(targetProduct.stock, 10);
        else if (targetProduct.api_stock !== undefined) stock = parseInt(targetProduct.api_stock, 10);
        
        const basePrice = parseFloat(targetProduct.price);
        return { price: basePrice, stock, tiers: [{ min: 1, max: Infinity, price: basePrice }] };
      }
    } catch (err) {
      console.warn(`AixShop API getPrice failed: ${err.message}, falling back to manual mode`);
    }
  }

  try {
    const client = await getClient();
    const botName = getBotUsername(supplier);
    let targetMessage = null;

    // 1. Send /start
    await client.sendMessage(botName, { message: '/start' });
    await new Promise(r => setTimeout(r, 500));

    // 2. Click Buy Coupon
    let buyBtnResult = await waitForButton(client, botName, ['Buy Coupon', 'Buy', 'Products'], ['Buy Coupon']);
    if (buyBtnResult) {
      await buyBtnResult.msg.click({ data: buyBtnResult.btn.data });
      await new Promise(r => setTimeout(r, 500));
    } else {
      throw new Error("Buy Coupon button not found.");
    }

    // 3. Click Product
    let productBtnResult = await waitForButton(client, botName, [serviceStr], [serviceStr, supplier.name || '']);
    if (productBtnResult) {
      await productBtnResult.msg.click({ data: productBtnResult.btn.data });
      await new Promise(r => setTimeout(r, 500));
    } else {
      throw new Error(`Product ${serviceStr} button not found.`);
    }

    // 4. Parse response
    let messages = await client.getMessages(botName, { limit: 5 });
    targetMessage = messages[0]; // fallback
    let productMsg = '';
    for (const msg of messages) {
      if (msg.message && (msg.message.includes('Available Stock') || msg.message.includes('Select Quantity'))) {
        targetMessage = msg;
        productMsg = msg.message;
        break;
      }
    }
    if (!productMsg) productMsg = targetMessage.message || '';

    // parse stock "Available Stock: 1040"
    const stockMatch = productMsg.match(/Available Stock:\s*(\d+)/i);
    const stock = stockMatch ? parseInt(stockMatch[1], 10) : Infinity;

    // parse tiers "Buy 1-99 ➔ ₹40 / 0.4 USDT"
    const regex = /Buy\s+(\d+)-?(\d*|\+)?\s*(?:➔|->)\s*.*?\/.*?([\d.]+)\s*USDT/gi;
    let tiers = [];
    let m;
    while ((m = regex.exec(productMsg)) !== null) {
      let min = parseInt(m[1]);
      let max = m[2] && m[2] !== '+' ? parseInt(m[2]) : Infinity;
      let price = parseFloat(m[3]);
      tiers.push({ min, max, price });
    }

    if (tiers.length === 0) {
      // fallback
      tiers.push({ min: 1, max: Infinity, price: 0 });
      const singlePriceMatch = productMsg.match(/([\d.]+)\s*USDT/i);
      if (singlePriceMatch) {
        tiers[0].price = parseFloat(singlePriceMatch[1]);
      }
    }

    // 5. Proceed to checkout for Qty = 1 to capture VIP/Custom price
    let qtyBtnResult = await waitForButton(client, botName, ['x1'], null);
    if (qtyBtnResult) {
      await qtyBtnResult.msg.click({ data: qtyBtnResult.btn.data });
      await new Promise(r => setTimeout(r, 500));
    } else {
      let customQtyBtnResult = await waitForButton(client, botName, ['Custom Qty', 'Custom Amount'], ['Custom Qty']);
      if (customQtyBtnResult) {
        await customQtyBtnResult.msg.click({ data: customQtyBtnResult.btn.data });
        await new Promise(r => setTimeout(r, 500));
      }
      await client.sendMessage(botName, { message: "1" });
      await new Promise(r => setTimeout(r, 500));
    }

    // 6. Read Checkout Screen
    let checkoutMsg = '';
    for (let i = 0; i < 8; i++) {
        const checkoutMessages = await client.getMessages(botName, { limit: 5 });
        for (const msg of checkoutMessages) {
           if (msg.message && (msg.message.includes('Custom Price') || msg.message.includes('Total Price') || msg.message.includes('Order Checkout'))) {
               checkoutMsg = msg.message;
               break;
           }
        }
        if (checkoutMsg) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    if (!checkoutMsg) {
        const fallbackMsgs = await client.getMessages(botName, { limit: 1 });
        checkoutMsg = fallbackMsgs[0] ? fallbackMsgs[0].message || '' : '';
    }

    // Look for VIP discount or Total price
    const customPriceMatch = checkoutMsg.match(/Custom Price:\s*([\d.]+)\s*USDT/i) || checkoutMsg.match(/Total Price:.*?\/.*?([\d.]+)\s*USDT/i);
    if (customPriceMatch) {
      const checkoutPrice = parseFloat(customPriceMatch[1]);
      if (checkoutPrice > 0) {
        // Override tiers with the actual VIP checkout price
        tiers = [{ min: 1, max: Infinity, price: checkoutPrice }];
      }
    }

    // Cancel order state to be clean for next operations
    await client.sendMessage(botName, { message: '/start' });

    return { price: tiers[0].price, stock, tiers };
  } catch (error) {
    cache.pendingPricePromises[serviceStr] = null;
    // Cache the error state for 30 seconds to prevent spamming /start
    cache.prices[serviceStr] = { price: 0, stock: 0, expires: Date.now() + 30000 };
    console.error(`AixShopBotAdapter getPrice Error:`, error.message);
    throw error;
  }
}

async function placeOrder(supplier, quantity) {
  const serviceStr = String(supplier.remote_service_id);
  const apiClient = getApiClient(supplier);

  if (apiClient) {
    try {
      const response = await apiClient.post('/api/v1/order', {
        service_id: supplier.remote_service_id,
        quantity: quantity
      });
      if (response.data && response.data.status === 'error') {
        throw new Error(response.data.message || 'API returned error status');
      }
      return response.data;
    } catch (err) {
      console.warn(`AixShop API placeOrder failed: ${err.message}, falling back to manual mode`);
      // if it's a balance or stock issue, don't fallback, just throw
      if (err.response?.status === 402 || err.response?.status === 400 || err.response?.status === 404) {
         throw err;
      }
    }
  }

  try {
    const client = await getClient();
    const botName = getBotUsername(supplier);
    let targetMessage = null;

    // 1. Send /start
    await client.sendMessage(botName, { message: '/start' });
    await new Promise(r => setTimeout(r, 2500));

    // 2. Click Buy Coupon
    let buyBtnResult = await waitForButton(client, botName, ['Buy Coupon', 'Buy', 'Products'], ['Buy Coupon']);
    if (buyBtnResult) {
      await buyBtnResult.msg.click({ data: buyBtnResult.btn.data });
      await new Promise(r => setTimeout(r, 500));
    } else {
      throw new Error("Buy Coupon button not found.");
    }

    // 3. Click Product
    let productBtnResult = await waitForButton(client, botName, [serviceStr], [serviceStr, supplier.name || '']);
    if (productBtnResult) {
      await productBtnResult.msg.click({ data: productBtnResult.btn.data });
      await new Promise(r => setTimeout(r, 500));
    } else {
      throw new Error(`Product ${serviceStr} button not found.`);
    }


    // 4. Select Quantity - Click "Custom Qty" or "x1"
    let qtyBtnResult = await waitForButton(client, botName, [`x${quantity}`], null);
    if (qtyBtnResult) {
      await qtyBtnResult.msg.click({ data: qtyBtnResult.btn.data });
      await new Promise(r => setTimeout(r, 500));
    } else {
      let customQtyBtnResult = await waitForButton(client, botName, ['Custom Qty', 'Custom Amount'], ['Custom Qty']);
      if (customQtyBtnResult) {
        await customQtyBtnResult.msg.click({ data: customQtyBtnResult.btn.data });
        await new Promise(r => setTimeout(r, 500));
      }
      // 5. Send quantity text
      await client.sendMessage(botName, { message: String(quantity) });
      await new Promise(r => setTimeout(r, 500));
    }

    // 6. Checkout Screen - Wait for Pay via Bot Wallet
    let applyDiscountBtn = null;
    const payResult = await waitForButton(client, botName, ['Pay via Bot Wallet', 'Bot Wallet'], ['Pay via Bot Wallet']);
    if (payResult) {
      targetMessage = payResult.msg;
    }

    // Apply Discount Code configuration (for future)
    const USE_DISCOUNT_CODE = false; // Set to true to enable
    const DISCOUNT_CODE = "SABITKOD"; // Your fixed discount code

    if (USE_DISCOUNT_CODE) {
      applyDiscountBtn = userBotManager.findButton(targetMessage, ['Apply Discount Code']) || userBotManager.findButtonPartial(targetMessage, 'Discount Code');
      if (applyDiscountBtn) {
        await targetMessage.click({ data: applyDiscountBtn.data });
        await new Promise(r => setTimeout(r, 2500));
        // enter the code
        await client.sendMessage(botName, { message: DISCOUNT_CODE });
        await new Promise(r => setTimeout(r, 2500));
        // wait for checkout screen again
        const newPayResult = await waitForButton(client, botName, ['Pay via Bot Wallet', 'Bot Wallet'], ['Pay via Bot Wallet']);
        if (newPayResult) {
          targetMessage = newPayResult.msg;
        }
      }
    }

    // Click "Pay via Bot Wallet"
    if (payResult) {
      const payBtn = payResult.btn;
      await targetMessage.click({ data: payBtn.data });
      await new Promise(r => setTimeout(r, 500));
    } else {
      throw new Error(`Pay via Bot Wallet button not found.`);
    }

    // Wait for final response
    await new Promise(r => setTimeout(r, 500)); // waitForButton will do the actual waiting for Crypto Wallet

    // 7. Select Wallet Currency - Wait for Crypto Wallet
    const cryptoResult = await waitForButton(client, botName, ['Crypto Wallet (USDT)', 'Crypto Wallet'], ['Crypto Wallet']);
    let messages;
    if (cryptoResult) {
      await cryptoResult.msg.click({ data: cryptoResult.btn.data });
      // Wait for the final delivery of products
      await new Promise(r => setTimeout(r, 4500)); // Give enough time for product delivery
      messages = await client.getMessages(botName, { limit: 5 });
    } else {
      throw new Error(`Crypto Wallet button not found.`);
    }

    let products = [];
    let orderId = null;

    // 1. Extract Order ID from messages
    for (const msg of messages) {
      if (msg.message && msg.message.includes('Order ID:')) {
        const match = msg.message.match(/Order ID:\s*([A-Z0-9_]+)/i);
        if (match && !orderId) orderId = match[1];
      }
    }

    // 2. Check if a document (.txt file) was sent for bulk orders
    let foundDocument = false;
    for (const msg of messages) {
      if (msg.media && (msg.media.document || msg.document)) {
        foundDocument = true;
        try {
          const buffer = await client.downloadMedia(msg);
          if (buffer) {
            const fileText = buffer.toString('utf-8');
            const fileLines = fileText.split('\n');
            for (const fileLine of fileLines) {
              if (fileLine.trim()) {
                let cleanLine = fileLine.trim();
                // Remove prefixes like "link1:", "code1:" if they exist
                cleanLine = cleanLine.replace(/^(?:link|code)\d+:\s*/i, '');
                products.push(cleanLine);
              }
            }
          }
        } catch (err) {
          console.error("AixShopBotAdapter Failed to download media:", err);
        }
        break;
      }
    }

    // 3. If no document, parse text message
    if (!foundDocument) {
      let targetMsg = messages.find(m => m.message && (m.message.toLowerCase().includes('here is your') || m.message.toLowerCase().includes('links:')));
      if (!targetMsg) targetMsg = messages[0];

      const deliveryMsg = targetMsg.message || '';
      let capture = false;

      const lines = deliveryMsg.split('\n');
      for (const line of lines) {
        if (capture && line.trim()) {
          let cleanLine = line.trim();
          cleanLine = cleanLine.replace(/^(?:link|code)\d+:\s*/i, '');
          products.push(cleanLine);
        }
        if (line.toLowerCase().includes('here is your') || line.toLowerCase().includes('links:')) {
          capture = true;
        }
      }

      if (products.length === 0) {
        if (/Your Wallet|Top Up|Insufficient|Choose an option|Select your payment|Order Checkout/i.test(deliveryMsg)) {
          throw new Error("Purchase failed, received bot menu instead of product: " + deliveryMsg.substring(0, 60).replace(/\n/g, ' '));
        }
        products = [deliveryMsg];
      }
    }

    return {
      success: true,
      order_id: orderId,
      products: products
    };
  } catch (error) {
    console.error(`AixShopBotAdapter placeOrder Error:`, error.message);
    throw error;
  }
}

module.exports = {
  getBalance,
  getPrice,
  placeOrder
};
