/**
 * caption.js - the small line under a ring legend, e.g. "4 of 5 running".
 *
 * Formatting is Indian-convention on purpose: a founder reading "₹1.32 Cr"
 * reads it in one glance, and reading "13,200,000" takes a second and a half
 * and a recount of the digits.
 */

/** What we print when there is no number. Never "0". */
export const EMPTY = '—';

/** 119428 -> "1,19,428" (last three, then pairs). */
function indianGroup(intString) {
  const s = String(intString);
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
}

/** Strip trailing zeros from a fixed-decimal string: "44.00" -> "44". */
function trimZeros(fixed) {
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/** Indian comma grouping for any number, keeping up to 2 decimals. */
export function formatIndianNumber(value, decimals = 0) {
  const neg = value < 0;
  const abs = Math.abs(value);
  const fixed = abs.toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const grouped = indianGroup(intPart);
  const out = decPart ? `${grouped}.${decPart}` : grouped;
  return (neg ? '-' : '') + out;
}

/** 103 -> "1m43s", 43 -> "43s", 3723 -> "1h2m3s". */
export function formatDuration(seconds) {
  const neg = seconds < 0;
  const total = Math.round(Math.abs(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  let out = '';
  if (h) out += `${h}h`;
  if (h || m) out += `${m}m`;
  out += `${s}s`;
  return (neg ? '-' : '') + out;
}

/** 13200000 -> "₹1.32 Cr", 4400000 -> "₹44L", 168000 -> "₹1.68L", 44000 -> "₹44,000". */
export function formatCurrencyInr(value) {
  const neg = value < 0;
  const abs = Math.abs(value);
  let body;
  if (abs >= 1e7) {
    body = `₹${(abs / 1e7).toFixed(2)} Cr`;
  } else if (abs >= 1e5) {
    body = `₹${trimZeros((abs / 1e5).toFixed(2))}L`;
  } else {
    const decimals = Number.isInteger(abs) ? 0 : 2;
    body = `₹${formatIndianNumber(abs, decimals)}`;
  }
  return (neg ? '-' : '') + body;
}

/** Western grouping: 1234567 -> "1,234,567". For everything that is not INR. */
export function formatWesternNumber(value, decimals = 0) {
  const neg = value < 0;
  const fixed = Math.abs(value).toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + (decPart ? `${grouped}.${decPart}` : grouped);
}

/**
 * 1200000 -> "$1.2M", 12400 -> "$12.4K", 950 -> "$950".
 *
 * Deliberately NOT lakh/crore. Indian grouping is correct for rupees and wrong
 * for dollars, and a US number printed as "$1.24L" is a number nobody can read.
 */
export function formatCurrencyUsd(value) {
  const neg = value < 0;
  const abs = Math.abs(value);
  let body;
  if (abs >= 1e6) {
    body = `$${trimZeros((abs / 1e6).toFixed(1))}M`;
  } else if (abs >= 1e3) {
    body = `$${trimZeros((abs / 1e3).toFixed(1))}K`;
  } else {
    body = `$${formatWesternNumber(abs, Number.isInteger(abs) ? 0 : 2)}`;
  }
  return (neg ? '-' : '') + body;
}

/** 12 -> "12d", 1.5 -> "1.5d". Cycle time and time-to-close live in days. */
export function formatDurationDays(days) {
  const rounded = Math.round(days * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}d`;
}

/**
 * Format a raw value for display, by the metric's unit.
 * @param {number|null|undefined} value
 * @param {'count'|'currency_inr'|'percent'|'duration'|string} [unit]
 * @returns {string}
 */
export function formatValue(value, unit) {
  if (value === null || value === undefined) return EMPTY;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return EMPTY;

  switch (unit) {
    case 'currency_inr': return formatCurrencyInr(n);
    case 'currency_usd': return formatCurrencyUsd(n);
    case 'duration': return formatDuration(n);
    case 'duration_days': return formatDurationDays(n);
    case 'percent': return `${Math.round(n)}%`;
    case 'count': return formatIndianNumber(Math.round(n), 0);
    default:
      return Number.isInteger(n) ? formatIndianNumber(n, 0) : formatIndianNumber(n, 2);
  }
}

/**
 * Render a caption template.
 *
 * Tokens: {{raw}} {{denominator}} {{denominator_label}} {{normalized}} {{target}}
 * raw / denominator / target format by `values.unit`; normalized is a bare
 * 0..100 integer.
 *
 * When denominator_label is empty the double space it leaves behind is
 * collapsed, so "{{raw}} of {{denominator}} {{denominator_label}}" with no
 * label still reads "₹1.68L of ₹6.7L" and not "₹1.68L of ₹6.7L ".
 *
 * @param {string} template
 * @param {Object} values {raw, denominator, denominator_label, normalized, target, unit}
 * @returns {string}
 */
export function renderCaption(template, values = {}) {
  if (!template) return '';
  const unit = values.unit;

  const token = {
    raw: formatValue(values.raw, unit),
    denominator: formatValue(values.denominator, unit),
    denominator_label: values.denominator_label === null || values.denominator_label === undefined
      ? '' : String(values.denominator_label),
    normalized: values.normalized === null || values.normalized === undefined
      ? EMPTY : String(Math.round(values.normalized)),
    target: formatValue(values.target, unit)
  };

  const out = String(template).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key) => {
    const k = String(key).toLowerCase();
    return Object.prototype.hasOwnProperty.call(token, k) ? token[k] : whole;
  });

  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

export default renderCaption;
