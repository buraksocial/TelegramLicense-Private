const { ORDER_LOG_CHANNEL } = require('../config/env');

function getFormattedIST() {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = String(d.getDate()).padStart(2, '0');
    const month = d.toLocaleString('en-US', { month: 'short' });
    const year = d.getFullYear();
    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const hoursStr = String(hours).padStart(2, '0');
    return `${day} ${month} ${year} ${hoursStr}:${minutes} ${ampm} IST`;
}

function maskId(id) {
    const str = String(id);
    if (str.length <= 6) return str;
    return str.slice(0, 3) + '***' + str.slice(-3);
}

function sendOrderLog(telegram, isReservation, userId, productName, quantity) {
    if (!ORDER_LOG_CHANNEL) return;
    const title = isReservation ? 'New Reservation!' : 'New Purchase!';
    const msg = ` ${title}

 ID: ${maskId(userId)}
 Product:  ${productName}
 Quantity: ${quantity}
 Time: ${getFormattedIST()}`;
    telegram.sendMessage(ORDER_LOG_CHANNEL, msg).catch(e => console.error("Could not send order log:", e.message));
}

function sendRestockLog(telegram, productName, addedQty, currentStock) {
    if (!ORDER_LOG_CHANNEL) return;
    const msg = ` Restock Alert!

 Product:  ${productName}
 Added: ${addedQty}
 Current Stock: ${currentStock}
 Time: ${getFormattedIST()}`;
    telegram.sendMessage(ORDER_LOG_CHANNEL, msg).catch(e => console.error("Could not send restock log:", e.message));
}

function sendWalletTopUpLog(telegram, userId, amount) {
    if (!ORDER_LOG_CHANNEL) return;
    const msg = `New Wallet Top-Up!

 ID: ${maskId(userId)}
 Amount Added: ${Number(amount).toFixed(2)} USDT
 Time: ${getFormattedIST()}`;
    telegram.sendMessage(ORDER_LOG_CHANNEL, msg).catch(e => console.error("Could not send wallet top-up log:", e.message));
}

module.exports = {
    sendOrderLog,
    sendRestockLog,
    sendWalletTopUpLog
};
