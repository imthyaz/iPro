import { describe, expect, it } from 'vitest';
import { formatPaise, rupeesToPaise } from './money.js';

describe('rupeesToPaise', () => {
  it('accepts Indian grouping, symbols and up to two decimals', () => {
    expect(rupeesToPaise('12,00,000')).toBe('120000000');
    expect(rupeesToPaise('₹ 1500.5')).toBe('150050');
    expect(rupeesToPaise('0.05')).toBe('5');
  });

  it('rejects anything that is not an amount', () => {
    expect(rupeesToPaise('')).toBeNull();
    expect(rupeesToPaise('12.345')).toBeNull();
    expect(rupeesToPaise('-5')).toBeNull();
    expect(rupeesToPaise('1e6')).toBeNull();
  });
});

describe('formatPaise', () => {
  it('uses lakh/crore grouping', () => {
    expect(formatPaise('120000000')).toBe('₹12,00,000');
    expect(formatPaise('1234567890')).toBe('₹1,23,45,678.90');
    expect(formatPaise('5')).toBe('₹0.05');
    expect(formatPaise('99900')).toBe('₹999');
  });
});
