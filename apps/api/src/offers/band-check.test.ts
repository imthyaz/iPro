import { expect, it } from 'vitest';
import { checkBand, needsHrHead } from './offers.service.js';

const lakh = (n: number) => BigInt(n) * 100_000n * 100n;

it('compares annual pay with the band maximum', () => {
  expect(checkBand({ amount: String(lakh(10)), rateUnit: 'year' }, lakh(10))).toBe('within');
  expect(checkBand({ amount: String(lakh(10) + 1n), rateUnit: 'year' }, lakh(10))).toBe('above');
  // ₹90,000 a month is ₹10.8 lakh a year.
  expect(checkBand({ amount: '9000000', rateUnit: 'month' }, lakh(10))).toBe('above');
});

it('has nothing to check without pay or a band, and cannot compare day or hour rates', () => {
  expect(checkBand(undefined, lakh(10))).toBe('no_band');
  expect(checkBand({ amount: '100', rateUnit: 'year' }, null)).toBe('no_band');
  expect(checkBand({ amount: '800000', rateUnit: 'day' }, lakh(10))).toBe('not_comparable');
});

it('HR head approves above band and anything not comparable', () => {
  expect(needsHrHead('above')).toBe(true);
  expect(needsHrHead('not_comparable')).toBe(true);
  expect(needsHrHead('within')).toBe(false);
  expect(needsHrHead('no_band')).toBe(false);
});
