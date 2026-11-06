import { describe, expect, it } from 'vitest';
import { expiryNote, heldByGrant, usableBy, validUntil } from './comp-off-rules.js';

const grants = [
  { id: 'a', amount: 100, validUntil: '2026-03-01' },
  { id: 'b', amount: 50, validUntil: '2026-03-20' },
  { id: 'c', amount: 100, validUntil: '2026-04-10' },
];

describe('comp-off grants (decisions #71, #73, #76)', () => {
  it('is usable for the configured days after it is granted, or for ever with no expiry', () => {
    expect(validUntil('2026-01-01', 60)).toBe('2026-03-02');
    expect(validUntil('2026-12-20', 60)).toBe('2027-02-18');
    expect(validUntil('2026-01-01', null)).toBeNull();
  });

  it('uses the grant that expires first: what is left is held by the latest grants', () => {
    // Nothing taken: every grant holds all of it.
    expect(heldByGrant(grants, 250)).toEqual(
      new Map([
        ['a', 100],
        ['b', 50],
        ['c', 100],
      ]),
    );
    // One and a half days taken: they came out of a and b.
    expect(heldByGrant(grants, 100)).toEqual(
      new Map([
        ['a', 0],
        ['b', 0],
        ['c', 100],
      ]),
    );
    // One day taken: a is used up, b and c are whole.
    expect(heldByGrant(grants, 150)).toEqual(
      new Map([
        ['a', 0],
        ['b', 50],
        ['c', 100],
      ]),
    );
    // A balance above the grants is from an import or an HR adjustment, which doesn't expire.
    expect(heldByGrant(grants, 300).get('a')).toBe(100);
  });

  it('counts only grants still valid on the last day of the leave', () => {
    expect(usableBy(grants, 250, '2026-03-01')).toBe(250);
    expect(usableBy(grants, 250, '2026-03-02')).toBe(150);
    expect(usableBy(grants, 250, '2026-04-11')).toBe(0);
    // Half a day already used came out of a, so a holds a half day until it expires.
    expect(usableBy(grants, 200, '2026-03-02')).toBe(150);
    // A day from an adjustment stays usable.
    expect(usableBy(grants, 350, '2026-05-01')).toBe(100);
  });

  it('says what expired and why', () => {
    expect(expiryNote('2026-01-01', '2026-03-02', 100, 100)).toBe(
      'Comp-off for 1 Jan expired after 2 Mar',
    );
    expect(expiryNote('2026-01-01', '2026-03-02', 100, 50)).toBe(
      'Comp-off for 1 Jan expired after 2 Mar; 0.5 of 1 day had been used',
    );
  });
});
