const { db } = require('../db');
const SupplierManager = require('./SupplierManager');
const { t } = require('../utils/i18n');

class ReservationManager {
  constructor(bot) {
    this.bot = bot;
    this.intervalId = null;
    this.isRunning = false;
  }

  start(intervalMs = 10000) { // Default 10 seconds
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    this.intervalId = setInterval(() => this.processReservations(), intervalMs);
    console.log(`ReservationManager started, polling every ${intervalMs / 1000} seconds.`);
    
    // Run immediately once on start
    setTimeout(() => this.processReservations(), 5000);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('ReservationManager stopped.');
  }

  async processReservations() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // Charge unpaid reservations as soon as the user's balance is enough.
      // They must not trigger a supplier purchase before payment is collected.
      const waiting = db.prepare(`SELECT * FROM reservations
        WHERE status='WAITING_PAYMENT' ORDER BY created_at ASC`).all();
      for (const r of waiting) {
        const remaining = r.qty - r.fulfilled_qty;
        const user = db.prepare('SELECT balance FROM users WHERE id=?').get(r.user_id);
        const due = Number(r.unit_price || 0) * remaining;
        if (remaining > 0 && user && Number(user.balance || 0) >= due) {
          db.transaction(() => {
            db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(due, r.user_id);
            db.prepare("UPDATE reservations SET status='PENDING', paid_usd=COALESCE(paid_usd,0)+?, support_note=NULL WHERE id=?").run(due, r.id);
            db.prepare('INSERT INTO transactions (txid,user_id,product_id,amount,status) VALUES (?,?,?,?,?)')
              .run(`RESERVE_${r.id}_${Date.now()}`, r.user_id, r.product_id, due, 'SUCCESS');
          })();
          try { if (this.bot?.telegram) await this.bot.telegram.sendMessage(r.user_id, `✅ Rezervasyon #${r.id} için bakiye tahsil edildi. Ürün tedarik ediliyor; otomatik teslim yapılacak.`); } catch (e) {}
        }
      }

      // 1. Group paid reservations by product_id
      const activeReservations = db.prepare(`
        SELECT product_id, SUM(qty - fulfilled_qty) as needed_qty 
        FROM reservations 
        WHERE status IN ('PENDING', 'PARTIAL')
        GROUP BY product_id
      `).all();

      for (const group of activeReservations) {
        const productId = group.product_id;
        const neededQty = group.needed_qty;
        
        if (neededQty <= 0) continue;

        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
        if (!product) continue;

        try {
          console.log(`[ReservationManager] Checking product ${productId} (Needs: ${neededQty})`);
          // Calculate how much we can actually afford and is in stock
          const affordableQty = await SupplierManager.getAffordableQuantity(product, neededQty);
          console.log(`[ReservationManager] Affordable Qty for ${productId}: ${affordableQty}`);
          
          if (affordableQty <= 0) {
             console.log(`[ReservationManager] Skipping product ${productId} - either API out of stock or insufficient API balance.`);
             continue; // We can't afford any or none in stock, skip this product for now
          }

          // Attempt to purchase the affordable quantity
          const orderResult = await SupplierManager.placeOrder(product, affordableQty);
          const apiResponse = orderResult.result;

          if (apiResponse && (apiResponse.success || (apiResponse.products && apiResponse.products.length > 0)) && apiResponse.products && apiResponse.products.length > 0) {
            const receivedProducts = apiResponse.products;
            let currentProductIndex = 0;

            // Fetch specific reservations for this product ordered by created_at ASC (FIFO)
            const reservations = db.prepare(`
              SELECT * FROM reservations 
              WHERE product_id = ? AND status IN ('PENDING', 'PARTIAL') 
              ORDER BY unit_price DESC, created_at ASC
            `).all(productId);

            for (const res of reservations) {
              if (currentProductIndex >= receivedProducts.length) break; // We ran out of received stock

              const resNeeded = res.qty - res.fulfilled_qty;
              const assignCount = Math.min(resNeeded, receivedProducts.length - currentProductIndex);
              
              if (assignCount <= 0) continue;

              const assignedData = [];
              const insertStock = db.prepare('INSERT INTO stocks (product_id, data, is_sold) VALUES (?, ?, 1)');
              
              db.transaction(() => {
                for (let i = 0; i < assignCount; i++) {
                  const data = receivedProducts[currentProductIndex++];
                  insertStock.run(productId, data);
                  assignedData.push(data);
                }
              })();

              const newFulfilledQty = res.fulfilled_qty + assignCount;
              const newStatus = newFulfilledQty >= res.qty ? 'COMPLETED' : 'PARTIAL';

              let currentData = [];
              try {
                if (res.delivered_data) {
                  currentData = JSON.parse(res.delivered_data);
                }
              } catch (e) {}
              const newData = JSON.stringify(currentData.concat(assignedData));

              db.prepare('UPDATE reservations SET fulfilled_qty = ?, status = ?, delivered_data = ? WHERE id = ?').run(
                newFulfilledQty, newStatus, newData, res.id
              );

              // Notify the user
              this.notifyUser(res.user_id, assignedData, res.qty, newFulfilledQty, newStatus, currentData.concat(assignedData));
            }
          }
        } catch (err) {
          console.log(`[ReservationManager] Error for product ${productId}:`, err.message);
          // It's normal for SupplierManager to fail if API is out of stock.
          // We just silently fail and try again next tick.
        }

        // Rate limit koruması: Bütün ürünlerin (api/v1/products) listesi tek seferde çekildiği 
        // ve 1 saniye önbellekte tutulduğu için, diğer ürünleri kontrol ederken API'ye istek gitmez.
        // Bu yüzden bekleme süresini 100ms'ye kadar düşürüp muazzam bir hız elde edebiliyoruz.
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (err) {
      console.error("Error in ReservationManager loop:", err);
    } finally {
      this.isRunning = false;
    }
  }

  notifyUser(userId, assignedData, totalQty, fulfilledQty, status, fullData = []) {
    if (!this.bot || !this.bot.telegram) return;
    
    const user = db.prepare('SELECT lang FROM users WHERE id = ?').get(userId);
    const lang = user?.lang || 'en';
    
    const dataToFormat = status === 'COMPLETED' ? fullData : assignedData;
    const combinedData = dataToFormat.join('\n------------------------\n');
    let message = "";
    let isFile = combinedData.length > 3500 || dataToFormat.length > 10;
    let fileDataStr = isFile ? (lang === 'tr' ? 'Ekli dosyayı kontrol ediniz. ⬇️' : 'Please check the attached file. ⬇️') : `<code>${combinedData}</code>`;

    if (status === 'COMPLETED') {
      message = t(lang, 'reserve_complete_delivery', { data: fileDataStr });
    } else {
      const remaining = totalQty - fulfilledQty;
      message = t(lang, 'reserve_partial_delivery', { delivered: assignedData.length, remaining: remaining, data: fileDataStr });
    }

    this.bot.telegram.sendMessage(userId, message, { parse_mode: 'HTML' })
      .then(() => {
        if (isFile) {
           const axios = require('axios');
           const FormData = require('form-data');
           const { BOT_TOKEN } = require('../config/env');
           
           const form = new FormData();
           form.append('chat_id', userId);
           form.append('document', Buffer.from(combinedData, 'utf-8'), { filename: 'products.txt', contentType: 'text/plain' });
           
           return axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, form, {
             headers: form.getHeaders(),
             timeout: 15000
           });
        }
      })
      .catch(err => {
        console.error(`Failed to send reservation notification to user ${userId}:`, err.message);
      });
  }
}

module.exports = ReservationManager;
