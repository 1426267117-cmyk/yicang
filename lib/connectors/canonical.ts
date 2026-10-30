const CURRENCY_EXPONENTS: Record<string, number> = {
  BHD: 3, CLF: 4, IQD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3,
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0,
  KRW: 0, PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0,
  XOF: 0, XPF: 0,
  AUD: 2, CAD: 2, CNY: 2, EUR: 2, GBP: 2, HKD: 2, MXN: 2,
  NZD: 2, SGD: 2, USD: 2,
};

export function normalizeSku(value: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLocaleUpperCase('en-US') : null;
}

export function exactMoney(value: unknown) {
  const bag = asRecord(value)?.shopMoney;
  const money = asRecord(bag);
  const amount = typeof money?.amount === 'string' ? normalizeDecimal(money.amount) : null;
  const currency = typeof money?.currencyCode === 'string' ? money.currencyCode : null;
  if (amount === null || currency === null) return null;
  return { amount, currency, minor: decimalToMinor(amount, currency) };
}

export function normalizeDecimal(value: string) {
  const match = value.trim().match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const sign = match[1] === '-' ? '-' : '';
  const integer = match[2].replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  return `${sign}${integer}${fraction ? `.${fraction}` : ''}`;
}

export function decimalToMinor(amount: string, currency: string) {
  const exponent = CURRENCY_EXPONENTS[currency];
  if (exponent === undefined) return null;
  const normalized = normalizeDecimal(amount);
  if (normalized === null) return null;
  const negative = normalized.startsWith('-');
  const unsigned = normalized.replace(/^[+-]/, '');
  const [integer, rawFraction = ''] = unsigned.split('.');
  const overflow = rawFraction.slice(exponent);
  if (overflow && /[1-9]/.test(overflow)) return null;
  const fraction = rawFraction.slice(0, exponent).padEnd(exponent, '0');
  const scale = BigInt(10) ** BigInt(exponent);
  let minor = BigInt(integer) * scale + BigInt(fraction || '0');
  if (negative) minor = -minor;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < BigInt(Number.MIN_SAFE_INTEGER)) return null;
  return Number(minor);
}

export function sourceBusinessDate(isoValue: string, timezone: string | null) {
  if (!timezone) return null;
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function stringOrNull(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function booleanOrNull(value: unknown) {
  return typeof value === 'boolean' ? value : null;
}

export function integerOrNull(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

export function requireString(value: unknown, field: string) {
  const result = stringOrNull(value);
  if (result === null) throw new Error(`INVALID_SHOPIFY_FIELD:${field}`);
  return result;
}

export function requireInteger(value: unknown, field: string) {
  const result = integerOrNull(value);
  if (result === null) throw new Error(`INVALID_SHOPIFY_FIELD:${field}`);
  return result;
}
