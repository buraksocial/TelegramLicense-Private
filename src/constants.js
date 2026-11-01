/**
 * Shared tunables. Everything here can be overridden by env so ops can
 * retune rate limits / polling on the VDS without a code change.
 */
const env = (key, fallback) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};
const num = (key, fallback) => {
  const v = parseFloat(env(key, ''));
  return Number.isFinite(v) ? v : fallback;
};

// How often the catalog refresher pulls a supplier's full product list.
// One request per supplier per interval — never per product.
const DEFAULT_CATALOG_POLL_MS = num('CATALOG_POLL_MS', 60000);

// A snapshot older than this is considered stale for display purposes.
const CATALOG_MAX_AGE_MS = num('CATALOG_MAX_AGE_MS', 5 * 60000);

// Balance is fetched at most this often per supplier.
const BALANCE_TTL_MS = num('BALANCE_TTL_MS', 15000);

// How long a customer-facing price lock is honoured after being shown.
const PRICE_LOCK_TTL_MS = num('PRICE_LOCK_TTL_MS', 10 * 60000);

// Cooldown between repeated admin margin alerts for the same product.
const MARGIN_ALERT_COOLDOWN_MS = num('MARGIN_ALERT_COOLDOWN_MS', 30 * 60000);

// Per-supplier request budgets (requests per window_ms). These mirror the
// documented limits; the governor stays under them on purpose.
//   min_interval_ms : hard floor between two consecutive calls
//   shared          : ONE bucket for all endpoints (the platform counts
//                     requests per API key, not per path). Verified live for
//                     the Scalar family: /me + /products fired together =>
//                     /products got 429 "1 request every 10 seconds".
const RATE_LIMITS = {
  lootpaglu: { requests: num('RL_LOOTPAGLU_R', 2), window_ms: num('RL_LOOTPAGLU_W', 1000), min_interval_ms: 400 }, // docs: 3 req/s
  aivault: { requests: num('RL_AIVAULT_R', 50), window_ms: num('RL_AIVAULT_W', 60000), min_interval_ms: 0 }, // docs: 60/min
  cuppon: { requests: num('RL_CUPPON_R', 50), window_ms: num('RL_CUPPON_W', 60000), min_interval_ms: 0 }, // docs: 60/min
  bunny: { requests: num('RL_BUNNY_R', 20), window_ms: num('RL_BUNNY_W', 60000), min_interval_ms: 500 }, // undocumented -> conservative
  aiversexhub: { requests: 1, window_ms: num('RL_AIVERSEX_W', 10000), min_interval_ms: 12000, shared: true }, // 1 req / 10s per KEY (+2s safety)
  uniqueaizone: { requests: 1, window_ms: num('RL_UNIQUE_W', 10000), min_interval_ms: 12000, shared: true }, // same platform
  aixshopbot: { requests: num('RL_AIX_R', 6), window_ms: num('RL_AIX_W', 60000), min_interval_ms: 3000 } // userbot UI: slow on purpose
};

// Languages the bot ships with. New rows can be added at runtime via the
// `languages` table; this list only seeds the table on first run.
const CORE_LANGS = [
  { code: 'en', native: 'English', flag: '🇬🇧' },
  { code: 'tr', native: 'Türkçe', flag: '🇹' },
  { code: 'ru', native: 'Русский', flag: '🇷🇺' },
  { code: 'zh', native: '中文', flag: '🇨' },
  { code: 'hi', native: 'हिन्दी', flag: '🇮' },
  { code: 'de', native: 'Deutsch', flag: '🇩🇪' },
  { code: 'fr', native: 'Français', flag: '🇫🇷' }
];

// Currency units we translate month/duration names for.
const DURATION_WORDS = {
  m: { en: 'Months', tr: 'Aylık', ru: 'Месяцев', zh: '个月', hi: 'महीने', de: 'Monate', fr: 'Mois' },
  y: { en: 'Year', tr: 'Yıllık', ru: 'Год', zh: '年', hi: 'वर्ष', de: 'Jahr', fr: 'An' },
  d: { en: 'Days', tr: 'Günlük', ru: 'Дней', zh: '天', hi: 'दिन', de: 'Tage', fr: 'Jours' },
  w: { en: 'Weeks', tr: 'Haftalık', ru: 'Недель', zh: '周', hi: 'सप्ताह', de: 'Wochen', fr: 'Semaines' }
};

module.exports = {
  DEFAULT_CATALOG_POLL_MS,
  CATALOG_MAX_AGE_MS,
  BALANCE_TTL_MS,
  PRICE_LOCK_TTL_MS,
  MARGIN_ALERT_COOLDOWN_MS,
  RATE_LIMITS,
  CORE_LANGS,
  DURATION_WORDS
};
