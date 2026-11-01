require('dotenv').config();

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  ADMIN_ID: parseInt(process.env.ADMIN_ID, 10),
  BINANCE_PAY_ID: process.env.BINANCE_PAY_ID || '123456789',
  BINANCE_API_KEY: process.env.BINANCE_API_KEY,
  BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY,
  FORCE_CHANNEL: process.env.FORCE_CHANNEL,
  FORCE_GROUP: process.env.FORCE_GROUP,
  ORDER_LOG_CHANNEL: process.env.ORDER_LOG_CHANNEL,
  TELEGRAM_API_ID: process.env.TELEGRAM_API_ID,
  TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH,
  TELEGRAM_SESSION: process.env.TELEGRAM_SESSION,
  AIVERSEXHUB_BOT_USERNAME: process.env.AIVERSEXHUB_BOT_USERNAME || 'AIVerseXBot',

  // ---- Supplier credentials (single source of truth; DB is seeded from these) ----
  SUPPLIERS: {
    lootpaglu: {
      base_url: process.env.LOOTPAGLU_BASE_URL || 'https://lootpaglu.in',
      api_key: process.env.LOOTPAGLU_API_KEY
    },
    aivault: {
      base_url: process.env.AIVAULT_BASE_URL || 'https://reseller.aivaulthub.store',
      api_key: process.env.AIVAULT_API_KEY
    },
    cuppon: {
      base_url: process.env.CUPPON_BASE_URL || 'https://cupponhub.shop',
      api_key: process.env.CUPPON_API_KEY
    },
    bunny: {
      base_url: process.env.BUNNY_BASE_URL || 'https://bunnytoolsbot.tech',
      api_key: process.env.BUNNY_API_KEY
    },
    aiversexhub: {
      base_url: process.env.AIVERSEX_BASE_URL || 'https://aiversehub.store',
      api_key: process.env.AIVERSEX_API_KEY
    },
    uniqueaizone: {
      base_url: process.env.UNIQUEAIZONE_BASE_URL || 'https://uniqueaizone.grabtools.io',
      api_key: process.env.UNIQUEAIZONE_API_KEY
    }
  },

  // ---- Translation LLM (OpenAI-compatible) ----
  LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://api.developer.org.tr/v1',
  LLM_API_KEY: process.env.LLM_API_KEY,
  LLM_MODEL: process.env.LLM_MODEL || 'gpt-6.1-sol',

  // ---- Web store ----
  WEB_ENABLED: ['1', 'true', 'yes'].includes(String(process.env.WEB_ENABLED || '1').toLowerCase()),
  WEB_PORT: parseInt(process.env.WEB_PORT, 10) || 3000,

  // ---- Safety switch: when truthy, no write order is ever sent to a supplier ----
  SUPPLIER_DRY_RUN: ['1', 'true', 'yes'].includes(String(process.env.SUPPLIER_DRY_RUN || '').toLowerCase())
};
