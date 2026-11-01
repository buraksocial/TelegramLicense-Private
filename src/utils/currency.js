const axios = require('axios');

let cachedRate = null;
let lastFetchTime = 0;
const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour

async function getUsdTryRate() {
  const now = Date.now();
  if (cachedRate && (now - lastFetchTime < CACHE_DURATION_MS)) {
    return cachedRate;
  }

  try {
    const res = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
    if (res.data && res.data.rates && res.data.rates.TRY) {
      cachedRate = parseFloat(res.data.rates.TRY);
      lastFetchTime = now;
      return cachedRate;
    }
  } catch (err) {
    console.error('Error fetching exchange rate:', err.message);
  }

  // Fallback if API fails
  return cachedRate || 47.22;
}

module.exports = {
  getUsdTryRate
};
