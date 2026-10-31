import { describe, expect, it } from 'vitest';
import { addDays, planChange, rowAt } from './effective-dating.js';

const v1 = { id: 'v1', effectiveFrom: '2024-04-01', effectiveTo: null };

describe('addDays', () => {
  it('crosses months and leap days', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('rowAt', () => {
  const rows = [
    { id: 'a', effectiveFrom: '2024-01-01', effectiveTo: '2024-06-30' },
    { id: 'b', effectiveFrom: '2024-07-01', effectiveTo: null },
  ];
  it('finds the row in force, with inclusive end dates', () => {
    expect(rowAt(rows, '2024-06-30')?.id).toBe('a');
    expect(rowAt(rows, '2024-07-01')?.id).toBe('b');
    expect(rowAt(rows, '2023-12-31')).toBeUndefined();
  });
});

describe('planChange', () => {
  it('closes the open row the day before and opens a new open row', () => {
    expect(planChange([v1], '2026-11-01')).toEqual({
      ok: true,
      close: { id: 'v1', effectiveTo: '2026-10-31' },
      newRow: { effectiveFrom: '2026-11-01', effectiveTo: null },
      basedOn: 'v1',
    });
  });

  it('inserts between rows without overlapping the later one', () => {
    const rows = [
      { id: 'v1', effectiveFrom: '2024-04-01', effectiveTo: '2026-11-30' },
      { id: 'v2', effectiveFrom: '2026-12-01', effectiveTo: null },
    ];
    expect(planChange(rows, '2026-11-15')).toEqual({
      ok: true,
      close: { id: 'v1', effectiveTo: '2026-11-14' },
      newRow: { effectiveFrom: '2026-11-15', effectiveTo: '2026-11-30' },
      basedOn: 'v1',
    });
  });

  it('back-dates before the first row up to the day before it starts', () => {
    expect(planChange([v1], '2024-01-01')).toEqual({
      ok: true,
      close: null,
      newRow: { effectiveFrom: '2024-01-01', effectiveTo: '2024-03-31' },
      basedOn: null,
    });
  });

  it('starts the first row of an empty history open-ended', () => {
    expect(planChange([], '2024-01-01')).toMatchObject({
      ok: true,
      close: null,
      newRow: { effectiveFrom: '2024-01-01', effectiveTo: null },
    });
  });

  it('refuses a second row starting the same day', () => {
    expect(planChange([v1], '2024-04-01')).toEqual({
      ok: false,
      problem: 'A version already starts on this date',
    });
  });
});
