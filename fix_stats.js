const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

console.log("Yanlış girilen 7445 TL siparişleri düzeltiliyor...");

// 7400'den büyük sell_try'a sahip ve muhtemelen hatalı olan "Manuel Satış" siparişlerini bul
// (Not: Sadece yakın zamandaki hatalı siparişi düzeltmek için limit veya tarih eklenebilir, 
// burada 7444 ile 7446 arasındaki tutarları arıyoruz.)
const wrongOrders = db.prepare('SELECT * FROM orders WHERE sell_try >= 7444 AND sell_try <= 7446').all();

if (wrongOrders.length === 0) {
    console.log("Hatalı sipariş bulunamadı (sell_try 7445 civarında olan).");
} else {
    for (const order of wrongOrders) {
        console.log(`Düzeltilecek Sipariş ID: ${order.id}, Mevcut sell_try: ${order.sell_try}`);
        
        // Asıl tutar 74.45 olmalı (100'e bölüyoruz)
        const newSellTry = order.sell_try / 100;
        const newSellUsd = order.sell_usd / 100;
        const newProfitUsd = newSellUsd - order.cost_usd;
        
        // tryRate = sell_try / sell_usd
        const tryRate = order.sell_try / order.sell_usd;
        const newProfitTry = newProfitUsd * tryRate;

        // Siparişi güncelle
        db.prepare(`
            UPDATE orders 
            SET sell_try = ?, sell_usd = ?, profit_usd = ?, profit_try = ?
            WHERE id = ?
        `).run(newSellTry, newSellUsd, newProfitUsd, newProfitTry, order.id);
        
        console.log(`Sipariş ${order.id} güncellendi: Yeni sell_try = ${newSellTry}`);
    }
}

// Transactions tablosunu da düzelt (amount_try 7445 civarı olanları)
const wrongTx = db.prepare("SELECT * FROM transactions WHERE amount_try >= 7444 AND amount_try <= 7446 AND status = 'completed'").all();

if (wrongTx.length === 0) {
    console.log("Hatalı işlem (transaction) bulunamadı.");
} else {
    for (const tx of wrongTx) {
        console.log(`Düzeltilecek İşlem ID: ${tx.id}, Mevcut amount_try: ${tx.amount_try}`);
        
        const newAmountTry = tx.amount_try / 100;
        const newAmountUsd = tx.amount / 100;
        
        db.prepare(`
            UPDATE transactions 
            SET amount_try = ?, amount = ?
            WHERE id = ?
        `).run(newAmountTry, newAmountUsd, tx.id);
        
        console.log(`İşlem ${tx.id} güncellendi: Yeni amount_try = ${newAmountTry}`);
    }
}

console.log("İşlem tamamlandı!");
