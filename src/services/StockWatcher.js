const { db } = require('../db');
const { sendOrderLog, sendRestockLog, sendWalletTopUpLog } = require('../utils/logger');
const lootPagluAdapter = require('./adapters/lootpaglu');
const aiVerseXHubAdapter = require('./adapters/aiversexhub');
const aixShopBotAdapter = require('./adapters/aixshopbot');

const adapters = {
  'lootpaglu': lootPagluAdapter,
  'aiversexhub': aiVerseXHubAdapter,
  'aixshopbot': aixShopBotAdapter
};

function getProductName(product, lang = 'en') {
    try {
        const names = JSON.parse(product.name);
        return names[lang] || names['en'] || product.name;
    } catch (e) {
        return product.name;
    }
}

function getRandomUserId() {
    return Math.floor(100000000 + Math.random() * 900000000);
}

// Helper to split a number into random pieces
function splitIntoRandomPieces(num) {
    if (num <= 1) return [num];
    const pieces = [];
    let remaining = num;
    while (remaining > 0) {
        // random chunk between 1 and remaining
        // We don't want 1 piece usually, maybe 1-5
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
        this.isStockRunning = false;
        this.previousStocks = {}; // productId -> stockCount
    }

    start(stockIntervalMs = 1500) {
        if (this.stockIntervalId) clearInterval(this.stockIntervalId);
        this.stockIntervalId = setInterval(() => this.processStock(), stockIntervalMs);
        
        console.log(`StockWatcher started. Polling API stock every ${stockIntervalMs / 1000}s.`);
        
        setTimeout(() => this.processStock(), 2000);
    }

    stop() {
        if (this.stockIntervalId) clearInterval(this.stockIntervalId);
        this.stockIntervalId = null;
        console.log('StockWatcher stopped.');
    }

    async processStock() {
        if (this.isStockRunning) return;
        this.isStockRunning = true;

        try {
            // Get all products that have mapped suppliers
            const products = db.prepare(`
                SELECT DISTINCT p.* FROM products p
                JOIN product_suppliers ps ON p.id = ps.product_id
            `).all();

            for (const product of products) {
                try {
                    // Query the highest priority supplier for this product
                    const supplier = db.prepare(`
                        SELECT s.type, s.base_url, s.api_key, ps.remote_service_id, s.name as supplier_name 
                        FROM product_suppliers ps 
                        JOIN suppliers s ON ps.supplier_id = s.id 
                        WHERE ps.product_id = ? 
                        ORDER BY ps.priority ASC LIMIT 1
                    `).get(product.id);

                    if (!supplier) continue;
                    const adapter = adapters[supplier.type];
                    if (!adapter) continue;

                    const info = await adapter.getPrice(supplier);
                    let currentStock = typeof info === 'object' ? info.stock : Infinity;
                    
                    if (currentStock === Infinity) currentStock = 10000;

                    const previousStock = this.previousStocks[product.id];
                    this.previousStocks[product.id] = currentStock;

                    if (previousStock !== undefined) {
                        if (currentStock > previousStock) {
                            const addedQty = currentStock - previousStock;
                            sendRestockLog(this.bot.telegram, getProductName(product, 'en'), addedQty, currentStock);
                        } else if (currentStock < previousStock) {
                            const decreasedQty = previousStock - currentStock;
                            
                            // Split the decrease into random fake purchases
                            const chunks = splitIntoRandomPieces(decreasedQty);
                            let logDelay = 0;
                            for (const chunkQty of chunks) {
                                const fakeUserId = getRandomUserId();
                                const isReservation = Math.random() > 0.5; // 50% chance it's shown as reservation
                                const productName = getProductName(product, 'en');
                                
                                logDelay += Math.floor(2000 + Math.random() * 3000); // 2 to 5 seconds apart
                                setTimeout(() => {
                                    sendOrderLog(this.bot.telegram, isReservation, fakeUserId, productName, chunkQty);
                                }, logDelay);
                            }
                            
                            // Trigger dynamic fake top-ups based on drawn stock value
                            this.triggerFakeTopUps(decreasedQty, product.price);
                        }
                    }

                } catch (err) {
                    // Silent fail for API errors on polling
                }

                // Small delay to prevent API rate limits across products
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        } catch (err) {
            console.error("Error in StockWatcher loop:", err);
        } finally {
            this.isStockRunning = false;
        }
    }

    triggerFakeTopUps(decreasedQty, productPrice) {
        if (!this.bot || !this.bot.telegram) return;

        const totalValue = decreasedQty * productPrice;
        // multiplier between 0.1x and 5.0x
        const multiplier = 0.1 + (Math.random() * 4.9);
        let targetTopUpTotal = parseFloat((totalValue * multiplier).toFixed(2));
        
        if (targetTopUpTotal < 1) targetTopUpTotal = 1;

        // 1 to 4 top-ups
        const numTopUps = Math.floor(Math.random() * 4) + 1;
        let remainingTotal = targetTopUpTotal;

        for (let i = 0; i < numTopUps; i++) {
            let topUpAmount;
            if (i === numTopUps - 1) {
                topUpAmount = parseFloat(remainingTotal.toFixed(2));
            } else {
                // random fraction of remaining (between 20% and 80%)
                const fraction = 0.2 + (Math.random() * 0.6); 
                topUpAmount = parseFloat((remainingTotal * fraction).toFixed(2));
                remainingTotal -= topUpAmount;
            }

            if (topUpAmount > 0) {
                // Random delay between 5 seconds and 4 minutes
                const delayMs = Math.floor(5000 + Math.random() * 235000);
                setTimeout(() => {
                    const fakeUserId = getRandomUserId();
                    sendWalletTopUpLog(this.bot.telegram, fakeUserId, topUpAmount);
                }, delayMs);
            }
        }
    }
}

module.exports = StockWatcher;
