import { describe, expect, it } from 'vitest';
import { maskLast4 } from './masking.js';

describe('maskLast4', () => {
  it('shows only the last 4 characters', () => {
    // Synthetic PAN-shaped value.
    expect(maskLast4('ABCDE1234F')).toBe('••••••234F');
  });

  it('hides short values completely', () => {
    expect(maskLast4('1234')).toBe('••••');
    expect(maskLast4('')).toBe('••••');
  });
});
