import { describe, expect, it } from 'vitest';
import {
  addDay,
  csvCell,
  emptyTotals,
  lopOf,
  payableOf,
  type PayrollDayInput,
} from './payroll-rules.js';

const day = (n: number, extra: Partial<PayrollDayInput> = {}): PayrollDayInput => ({
  day: `2026-09-${String(n).padStart(2, '0')}`,
  employed: true,
  working: true,
  holiday: false,
  status: 'present',
  mode: 'office',
  paidLeave: 0,
  unpaidLeave: 0,
  ...extra,
});

describe('the monthly attendance and loss-of-pay count (decision #77)', () => {
  it('matches a hand count for a synthetic September', () => {
    // September 2026: 30 days. Weekly offs on the 6th, 13th, 20th, 27th; a holiday on the 15th.
    const off = new Set([6, 13, 20, 27]);
    const special: Record<number, Partial<PayrollDayInput>> = {
      2: { status: 'wfh', mode: 'wfh' },
      3: { status: 'client_site', mode: 'client_site' },
      4: { status: 'leave', mode: null, paidLeave: 100 }, // casual leave
      7: { status: 'absent', mode: null }, // absent, no leave: 1 LOP
      8: { status: 'half_day', mode: 'office' }, // half day, no leave: 0.5 LOP
      9: { status: 'half_day', mode: 'office', paidLeave: 50 }, // half day + half casual: 0 LOP
      10: { status: 'leave', mode: null, unpaidLeave: 100 }, // loss-of-pay leave: 1 LOP
      11: { status: 'half_day', mode: null, paidLeave: 50, unpaidLeave: 50 }, // split shortfall
      14: { status: null, mode: null }, // never built: 1 LOP
      13: { status: 'present', mode: 'office' }, // worked a weekly off: paid, not extra
    };
    let totals = emptyTotals();
    for (let n = 1; n <= 30; n++) {
      totals = addDay(
        totals,
        day(n, {
          working: !off.has(n) && n !== 15,
          holiday: n === 15,
          ...(off.has(n) || n === 15 ? { status: null, mode: null } : {}),
          ...special[n],
        }),
      );
    }
    // By hand: 25 working days. Office = 25 − 1 wfh − 1 client − 1 leave − 1 absent − 1 LOP leave
    // − 1 split − 1 unbuilt − 0.5 (8th) − 0.5 (9th) = 17. Paid leave 1 + 0.5 + 0.5 = 2.
    expect(totals).toMatchObject({
      employed: 3000,
      office: 1700,
      wfh: 100,
      clientSite: 100,
      paidLeave: 200,
      lopLeave: 150,
      lopAbsent: 250,
      weeklyOff: 400,
      holiday: 100,
    });
    expect(lopOf(totals)).toBe(400);
    expect(payableOf(totals)).toBe(2600);
    expect(totals.lopDays).toEqual([
      { date: '2026-09-07', amount: 100, why: 'Absent, no leave' },
      { date: '2026-09-08', amount: 50, why: 'Half day, no leave for the other half' },
      { date: '2026-09-10', amount: 100, why: 'Loss-of-pay leave' },
      { date: '2026-09-11', amount: 50, why: 'Half day of loss-of-pay leave' },
      { date: '2026-09-14', amount: 100, why: 'No attendance recorded, no leave' },
    ]);
  });

  it('counts only the days employed: a joiner on the 16th', () => {
    let totals = emptyTotals();
    for (let n = 1; n <= 30; n++) totals = addDay(totals, day(n, { employed: n >= 16 }));
    expect(totals.employed).toBe(1500);
    expect(payableOf(totals)).toBe(1500);
  });

  it('writes CSV cells safely', () => {
    expect(csvCell('Ravi, K')).toBe('"Ravi, K"');
    expect(csvCell('Say "hi"')).toBe('"Say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell(-1.5)).toBe('-1.5');
    expect(csvCell(null)).toBe('');
  });
});
