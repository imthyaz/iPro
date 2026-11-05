import { describe, expect, it } from 'vitest';
import { halvesOverlap, planDays, splitShortfall, totalOf } from './request-rules.js';

// Mon–Fri working week; 2026-11-14/15 is a weekend, 2026-11-11 a holiday.
const isWorking = (day: string) => {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && day !== '2026-11-11';
};
const plan = (from: string, to: string, extra: Partial<Parameters<typeof planDays>[0]> = {}) =>
  planDays({
    from,
    to,
    startHalf: 'full',
    endHalf: 'full',
    countsCalendarDays: false,
    isWorking,
    ...extra,
  });

describe('the days a request covers', () => {
  it('skips weekly offs and holidays (sandwich rule off)', () => {
    const days = plan('2026-11-10', '2026-11-17');
    expect(days.map((d) => d.day)).toEqual([
      '2026-11-10',
      '2026-11-12',
      '2026-11-13',
      '2026-11-16',
      '2026-11-17',
    ]);
    expect(totalOf(days)).toBe(500);
  });

  it('counts calendar days for types that do (maternity)', () => {
    expect(totalOf(plan('2026-11-10', '2026-11-17', { countsCalendarDays: true }))).toBe(800);
  });

  it('half days at either end, and single mornings or afternoons', () => {
    const days = plan('2026-11-12', '2026-11-16', { startHalf: 'second', endHalf: 'first' });
    expect(days.map((d) => [d.day, d.half])).toEqual([
      ['2026-11-12', 'second'],
      ['2026-11-13', 'full'],
      ['2026-11-16', 'first'],
    ]);
    expect(totalOf(days)).toBe(200);
    expect(plan('2026-11-12', '2026-11-12', { endHalf: 'first' })).toEqual([
      { day: '2026-11-12', half: 'first', amount: 50 },
    ]);
    expect(() =>
      plan('2026-11-12', '2026-11-12', { startHalf: 'second', endHalf: 'first' }),
    ).toThrow(/morning or an afternoon/);
    expect(() => plan('2026-11-12', '2026-11-10')).toThrow(/ends before/);
    expect(plan('2026-11-14', '2026-11-15')).toEqual([]);
  });
});

describe('a short balance (decision #74)', () => {
  const days = plan('2026-11-12', '2026-11-17'); // Thu, Fri, Mon, Tue: 4 days
  it('uses the balance for the earliest days and the rest is loss of pay', () => {
    const { paid, lop } = splitShortfall(days, 200);
    expect(paid.map((d) => d.day)).toEqual(['2026-11-12', '2026-11-13']);
    expect(lop.map((d) => d.day)).toEqual(['2026-11-16', '2026-11-17']);
  });

  it('splits a day into halves when half a day is left', () => {
    const { paid, lop } = splitShortfall(days, 150);
    expect(totalOf(paid)).toBe(150);
    expect(totalOf(lop)).toBe(250);
    expect(paid.at(-1)).toEqual({ day: '2026-11-13', half: 'first', amount: 50 });
    expect(lop[0]).toEqual({ day: '2026-11-13', half: 'second', amount: 50 });
  });

  it('no balance: all loss of pay; enough balance: none', () => {
    expect(splitShortfall(days, 0).paid).toEqual([]);
    expect(splitShortfall(days, -100).lop).toHaveLength(4);
    expect(splitShortfall(days, 400).lop).toEqual([]);
  });

  it('halves overlap only themselves or a full day', () => {
    expect(halvesOverlap('first', 'second')).toBe(false);
    expect(halvesOverlap('first', 'first')).toBe(true);
    expect(halvesOverlap('full', 'second')).toBe(true);
  });
});
