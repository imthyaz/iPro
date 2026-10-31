/** Money is whole paise as a digit string (decision #33); no floating point anywhere. */

/** "12,00,000.50" or "1200000" rupees → "120000050" paise; null if not a valid amount. */
export function rupeesToPaise(input: string): string | null {
  const cleaned = input.replace(/[,\s₹]/g, '');
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const paise = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return paise.toString();
}

/** "120000050" → "₹12,00,000.50" (Indian grouping); whole rupees drop the ".00". */
export function formatPaise(paise: string): string {
  const value = BigInt(paise);
  const rupees = value / 100n;
  const rest = value % 100n;
  const digits = rupees.toString();
  const last3 = digits.slice(-3);
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+$)/g, ',');
  const grouped = head ? `${head},${last3}` : last3;
  return `₹${grouped}${rest === 0n ? '' : `.${rest.toString().padStart(2, '0')}`}`;
}

const units: Record<string, string> = {
  year: 'a year',
  month: 'a month',
  day: 'a day',
  hour: 'an hour',
};
export const rateLabel = (unit: string) => units[unit] ?? unit;
