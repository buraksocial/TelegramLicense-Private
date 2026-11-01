/**
 * StockWatcher — cosmetic activity log driven by the catalog SNAPSHOT.
 *
 * The old version polled each supplier API every 1500ms (main 429 source).
 * Now CatalogPoller refreshes supplier_catalogs at a governor-safe cadence
 * and this watcher merely diffs the stored numbers. Zero HTTP.
 */
const { db } = require('../db');
const { sendOrderLog, sendRestockLog, sendWalletTopUpLog } = require('../utils/logger');

function getProductName(product, lang = 'en') {
  try {
    const names = JSON.parse(product.name);
    return names[lang] || names.en || product.name;
  } catch (e) {
    return product.name;
  }
}

function getRandomUserId() {
  return Math.floor(100000000 + Math.random() * 900000000);
}

function splitIntoRandomPieces(num) {
  if (num <= 1) return [num];
  const pieces = [];
  let remaining = num;
  while (remaining > 0) {
    const chunk = Math.floor(Math.random() * Math.min(5, remaining)) + 1;
    pieces.push(chunk);
    remaining -= chunk;
  }
  return pieces;
}

class StockWatcher {
  constructor(bot) {
    this.bot = bot;
    this.stockIntervalId = null;
    this.previousStocks = {}; // productId -> stockCount
  }

  start(stockIntervalMs = 20000) {
    if (this.stockIntervalId) clearInterval(this.stockIntervalId);
    this.stockIntervalId = setInterval(() => this.processStock(), stockIntervalMs);
    console.log(`StockWatcher started (snapshot diff every ${stockIntervalMs / 1000}s, no API calls).`);
    setTimeout(() => this.processStock(), 3000);
  }

  stop() {
    if (this.stockIntervalId) clearInterval(this.stockIntervalId);
    this.stockIntervalId = null;
    console.log('StockWatcher stopped.');
  }

  /** Aggregate visible supplier stock for a product from the snapshot table. */
  currentStockFor(productId) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(sc.stock, ps.last_stock)), 0) AS total
         FROM product_suppliers ps
         LEFT JOIN supplier_catalogs sc
           ON sc.supplier_id = ps.supplier_id AND sc.remote_service_id = ps.remote_service_id
         WHERE ps.product_id = ? AND ps.enabled = 1`
      )
      .get(productId);
    return row ? row.total : 0;
  }

  async processStock() {
    try {
      const products = db
        .prepare('SELECT DISTINCT p.* FROM products p JOIN product_suppliers ps ON p.id = ps.product_id')
        .all();

      for (const product of products) {
        const currentStock = this.currentStockFor(product.id);
        const previousStock = this.previousStocks[product.id];
        this.previousStocks[product.id] = currentStock;
        if (previousStock === undefined) continue;

        if (currentStock > previousStock) {
          sendRestockLog(this.bot.telegram, getProductName(product, 'en'), currentStock - previousStock, currentStock);
        } else if (currentStock < previousStock) {
          const decreasedQty = previousStock - currentStock;
          const chunks = splitIntoRandomPieces(decreasedQty);
          let logDelay = 0;
          for (const chunkQty of chunks) {
            const fakeUserId = getRandomUserId();
            const isReservation = Math.random() > 0.5;
            const productName = getProductName(product, 'en');
            logDelay += Math.floor(2000 + Math.random() * 3000);
            setTimeout(() => {
              sendOrderLog(this.bot.telegram, isReservation, fakeUserId, productName, chunkQty);
            }, logDelay);
          }
          this.triggerFakeTopUps(decreasedQty, product.price);
        }
      }
    } catch (err) {
      console.error('Error in StockWatcher loop:', err);
    }
  }

  triggerFakeTopUps(decreasedQty, productPrice) {
    if (!this.bot || !this.bot.telegram) return;
    const totalValue = decreasedQty * productPrice;
    const multiplier = 0.1 + (Math.random() * 4.9);
    let targetTopUpTotal = parseFloat((totalValue * multiplier).toFixed(2));
    if (targetTopUpTotal < 1) targetTopUpTotal = 1;

    const numTopUps = Math.floor(Math.random() * 4) + 1;
    let remainingTotal = targetTopUpTotal;
    for (let i = 0; i < numTopUps; i++) {
      let topUpAmount;
      if (i === numTopUps - 1) {
        topUpAmount = parseFloat(remainingTotal.toFixed(2));
      } else {
        const fraction = 0.2 + Math.random() * 0.6;
        topUpAmount = parseFloat((remainingTotal * fraction).toFixed(2));
        remainingTotal -= topUpAmount;
      }
      if (topUpAmount > 0) {
        const delayMs = Math.floor(5000 + Math.random() * 235000);
        setTimeout(() => {
          sendWalletTopUpLog(this.bot.telegram, getRandomUserId(), topUpAmount);
        }, delayMs);
      }
    }
  }
}

module.exports = StockWatcher;
