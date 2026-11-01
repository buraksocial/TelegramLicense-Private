const axios = require('axios');
const crypto = require('crypto');
const { BINANCE_API_KEY, BINANCE_SECRET_KEY } = require('../config/env');

const BINANCE_BASE_URL = 'https://api.binance.com';

/**
 * Binance API ile TXID'nin durumunu ve tutarını kontrol eder.
 * @param {string} txid 
 * @returns {Promise<Object|null>} İşlem verisi veya hata durumunda null
 */
async function checkTransaction(txid) {
  try {
    // NOT: Binance Pay ödemeleri için endpoint sapi/v1/pay/transactions şeklindedir.
    // Bu örnekte standart on-chain Crypto Deposit kontrolü (TXID bazlı) yapılmıştır.
    // Eğer doğrudan Binance Pay C2B kullanıyorsanız veya Pay Order ID alıyorsanız endpointi ona göre revize etmelisiniz.
    const timestamp = Date.now();
    const queryString = `txId=${txid}&timestamp=${timestamp}`;
    const signature = crypto
      .createHmac('sha256', BINANCE_SECRET_KEY)
      .update(queryString)
      .digest('hex');

    const response = await axios.get(`${BINANCE_BASE_URL}/sapi/v1/capital/deposit/hisrec?${queryString}&signature=${signature}`, {
      headers: {
        'X-MBX-APIKEY': BINANCE_API_KEY
      }
    });

    const deposit = response.data.find(d => d.txId === txid);

    if (deposit) {
      return {
        amount: parseFloat(deposit.amount),
        // 1 = SUCCESS (Onaylanmış başarılı bakiye yatırma işlemi)
        status: deposit.status === 1 ? 'SUCCESS' : 'PENDING' 
      };
    }

    return null;
  } catch (error) {
    console.error('Binance API Hatası:', error.response?.data || error.message);
    return null;
  }
}

module.exports = {
  checkTransaction
};
