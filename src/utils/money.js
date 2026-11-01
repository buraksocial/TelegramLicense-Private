/**
 * Robust money parsing for admin/user text input.
 *
 * Fixes the historic "1,45 -> 145" class of bugs: every place that used to do
 * `parseFloat(text)` or `text.replace(/,/g,'')` silently mangled decimal
 * commas (Turkish style) or produced 100x values. parseMoney() understands
 * both separator conventions and currency noise, and returns null instead of
 * a wrong number so callers can re-prompt.
 *
 *  "1,45"        -> 1.45     (single comma, 1-2 decimals => decimal comma)
 *  "1,5"         -> 1.5
 *  "0.60"        -> 0.6
 *  "1,450"       -> 1450     (comma + exactly 3 digits => thousands grouping)
 *  "1.450"       -> 1.45     (a dot is ALWAYS a decimal point here; a price
 *                             field is small, so never inflate on a dot)
 *  "1.234,56"    -> 1234.56  (both present => last separator is decimal)
 *  "1,234.56"    -> 1234.56
 *  "15 USD"      -> 15       "₺47,22" -> 47.22   "$3.75" -> 3.75
 *  "abc"         -> null
 */
function parseMoney(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;

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
      const frac = parts[1];
      // exactly 3 trailing digits => thousands ("1,450" = 1450); otherwise decimal
      s = frac.length === 3 && /^\d+$/.test(frac) ? parts[0] + frac : parts[0] + '.' + frac;
    }
  } else if (hasDot) {
    const parts = s.split('.');
    if (parts.length > 2) {
      // "1.234.567" style grouping -> keep last segment as decimals
      s = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
    }
    // single dot => plain decimal, never inflate (a price field is small).
  }

  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
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
 * Heuristic detector for legacy rows corrupted by the old comma-stripping
 * bug: value looks ~100x larger than plausible for this shop.
 * Used only by scripts/audit_money.js (report-only).
 */
function looksHundredInflated(value, saneMax = 1000) {
  return typeof value === 'number' && Number.isFinite(value) && value >= saneMax;
}

module.exports = { parseMoney, parseMoneyOr, parseIntStrict, looksHundredInflated };
