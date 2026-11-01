/**
 * Warranty classification — "instant use" vs "X hour warranty" services.
 *
 * Suppliers sell the same plan in two flavours:
 *   guaranteed : replacement window (e.g. "Gemini Pro 18M 5H Warranty")
 *   instant    : no replacement ("18M pro ( Instant Use )")
 * Operators must be able to sell them as SEPARATE products: a guaranteed
 * order must never be fulfilled from instant stock, and an instant product
 * must never offer/serve guaranteed stock.
 */

function classifyWarranty(text) {
  const n = String(text || '').toLowerCase();
  if (!n) return 'unknown';
  if (/warrant|garanti|replace|refill|reissue|2 ?h\b|4 ?h\b|5 ?h\b|hour/.test(n) && !/no warrant|warrant(y)?\s*(yok|tidak)/.test(n)) {
    return 'guaranteed';
  }
  if (/instant|anl[iı]k|no warrant|kullan[iı]m\b/.test(n)) return 'instant';
  return 'unknown';
}

/**
 * Offer class visible to the pricing engine:
 *   linkOverride ('guaranteed'|'instant'|'mixed') wins over 'auto',
 *   otherwise the catalog row's classified warranty.
 */
function effectiveWarranty(linkWarranty, catalogWarranty) {
  const ow = String(linkWarranty || 'auto');
  if (ow !== 'auto') return ow;
  return String(catalogWarranty || 'unknown');
}

/**
 * Is this offer allowed for a product of the given class?
 *  product 'none'      → everything (legacy behaviour, launch-safe default)
 *  product 'guaranteed'→ ONLY guaranteed (or admin-confirmed 'mixed');
 *                        'unknown' is rejected so nobody pays warranty
 *                        price for instant stock.
 *  product 'instant'   → excludes guaranteed; unknown is allowed (risk
 *                        direction favours the customer).
 */
function warrantyAllows(productWarranty, offerClass) {
  const p = String(productWarranty || 'none');
  if (p === 'none') return true;
  if (p === 'guaranteed') return offerClass === 'guaranteed' || offerClass === 'mixed';
  if (p === 'instant') return offerClass !== 'guaranteed';
  return true;
}

const LABELS = {
  none: 'Klasik (filtresiz)',
  guaranteed: '🛡 Garantili',
  instant: '⚡ Anlık kullanım',
  unknown: '❓ Sınıflandırılmamış',
  auto: '🔄 Otomatik',
  mixed: '🤝 Eşdeğer (karışık)'
};

module.exports = { classifyWarranty, effectiveWarranty, warrantyAllows, LABELS };
