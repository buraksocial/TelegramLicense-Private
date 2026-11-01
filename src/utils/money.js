/**
 * Robust money parsing for admin/user text input.
 *
 * Fixes the historic "1,45 -> 145" class of bugs: every place that used to do
 * `parseFloat(text)` or `text.replace(/,/g,'')` silently mangled decimal
 * commas (Turkish style) or produced 100x values. parseMoney() understands
 * both separator conventions and currency noise, and returns null instead of
 * a wrong number so callers can re-prompt.
 *
 *  "1,45"        -> 1.45     (comma is ALWAYS the decimal separator)
 *  "1,5"         -> 1.5
 *  "1,450"       -> 1.45     (Turkish: comma = decimal, dot = thousands)
 *  "0.60"        -> 0.6
 *  "1.450"       -> 1.45     (USD context: a dot stays decimal, never inflate)
 *  "1.450 TL"    -> 1450     (TL context: dot = Turkish thousands separator)
 *  "1.234,56"    -> 1234.56  (both present => last separator is decimal)
 *  "1,234.56"    -> 1234.56
 *  "15 USD"      -> 15       "₺47,22" -> 47.22   "$3.75" -> 3.75
 *  "abc"         -> null
 */
function parseMoney(raw, opts = {}) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // Preserve a leading sign (balance adjustments like "-5").
  let sign = 1;
  s = s.replace(/^([+-])\s*/, (m, c) => { if (c === '-') sign = -1; return ''; });

  const isTL = opts.currency === 'TL' || opts.currency === 'TRY' || /\b(tl|try|₺)\b/i.test(s);

  // Strip currency words/symbols and whitespace, keep digits and separators.
  s = s
    .replace(/(usd|usdt|try|tl|eur|inr|₺|\$|€|£|%)/gi, '')
    .replace(/\s+/g, '')
    .replace(/[٫٬]/g, (m) => (m === '٫' ? ',' : '.')); // arabic separators

  if (!/\d/.test(s)) return null;

  const hasComma = s.includes(',');
  const hasDot = s.includes('.');

  if (hasComma && hasDot) {
    // The LAST separator is the decimal mark; the other is a thousands group.
    const lastIsComma = s.lastIndexOf(',') > s.lastIndexOf('.');
    const decimalSep = lastIsComma ? ',' : '.';
    const groupSep = lastIsComma ? '.' : ',';
    s = s.split(groupSep).join('');
    s = s.replace(decimalSep, '.');
  } else if (hasComma) {
    const parts = s.split(',');
    if (parts.length > 2) {
      // "1,234,567" style grouping
      s = parts.join('');
    } else {
      // A single comma is the DECIMAL separator (Turkish convention).
      // "1,45" -> 1.45, "1,450" -> 1.45. Never strip it (that was the
      // historic 100x corruption: "74,45" -> "7445").
      s = parts[0] + '.' + parts[1];
    }
  } else if (hasDot) {
    const parts = s.split('.');
    if (parts.length > 2) {
      // "1.234.567" style grouping -> keep last segment as decimals
      s = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
    } else if (isTL) {
      // Turkish TL convention: dot is a thousands separator (1.450 TL = 1450).
      const frac = parts[1];
      if (/^\d{3}$/.test(frac) && /^\d{1,3}$/.test(parts[0])) s = parts[0] + frac;
    }
    // USD with a single dot => plain decimal, never inflate (a price field is small).
  }

  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? sign * n : null;
}

/** Parse or throw a friendly message (for command handlers). */
function parseMoneyOr(raw, fallback = null) {
  const v = parseMoney(raw);
  return v === null ? fallback : v;
}

/** Integer parsing with comma/space noise stripped (quantities, ids). */
function parseIntStrict(raw) {
  const n = parseMoney(raw);
  if (n === null) return NaN;
  return Math.trunc(n);
}

/**
 * Quantity parser: pure counts, with optional thousands grouping.
 *  "1500" -> 1500 ; "1.500" -> 1500 ; "1,500" -> 1500 ; "1,5" -> NaN (not a count)
 */
function parseQuantity(raw) {
  const s = String(raw ?? '').trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(s)) return parseInt(s.replace(/[.,]/g, ''), 10);
  return NaN;
}

/**
 * Heuristic detector for legacy rows corrupted by the old comma-stripping
 * bug: value looks ~100x larger than plausible for this shop.
 * Used only by scripts/audit_money.js (report-only).
 */
function looksHundredInflated(value, saneMax = 1000) {
  return typeof value === 'number' && Number.isFinite(value) && value >= saneMax;
}

module.exports = { parseMoney, parseMoneyOr, parseIntStrict, parseQuantity, looksHundredInflated };
