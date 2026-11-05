import { describe, expect, it } from 'vitest';
import { defaultLeaveTypes, monthlyAccrual, roundToHalfDay, yearEnd } from './leave-rules.js';

const CL = { perYear: 1200, accruesAfterConfirmation: false };
const SL = { perYear: 1200, accruesAfterConfirmation: false };
const EL = { perYear: 1500, accruesAfterConfirmation: true };
const facts = (f: Partial<Parameters<typeof monthlyAccrual>[1]>) => ({
  joiningDate: '2024-01-08',
  lastWorkingDate: null,
  confirmationDate: '2024-07-08',
  hasProbation: true,
  ...f,
});
const credit = (t: typeof CL, f: Parameters<typeof facts>[0]) =>
  monthlyAccrual(t, facts(f), '2026-03').amount / 100;

/**
 * Done-when #1: March 2026 (31 days) accruals for a hand-calculated sample of 10 synthetic people.
 * CL and SL are 1 day a month, EL 1.25 after confirmation; part months are pro-rata by days to the
 * nearest half day. EL applies to permanent and fixed-term staff only (people 8 and 9 get none: see
 * the applies-to test below).
 */
const sample: [string, Parameters<typeof facts>[0], number, number, number][] = [
  // who, facts, CL, SL, EL — worked out by hand.
  ['1 confirmed, whole month', {}, 1, 1, 1.25],
  ['2 joined 1 Mar, on probation', { joiningDate: '2026-03-01', confirmationDate: null }, 1, 1, 0],
  // 16 of 31 days: 16/31 = 0.516 → 0.5.
  ['3 joined 16 Mar', { joiningDate: '2026-03-16', confirmationDate: null }, 0.5, 0.5, 0],
  // 22 of 31 days: 0.710 → 0.5 (nearer than 1).
  ['4 joined 10 Mar', { joiningDate: '2026-03-10', confirmationDate: null }, 0.5, 0.5, 0],
  // 27 of 31 days: 0.871 → 1.
  ['5 joined 5 Mar', { joiningDate: '2026-03-05', confirmationDate: null }, 1, 1, 0],
  // EL from 20 Mar: 12 of 31 days of 1.25 = 0.484 → 0.5.
  ['6 confirmed 20 Mar', { joiningDate: '2025-09-20', confirmationDate: '2026-03-20' }, 1, 1, 0.5],
  // 12 of 31 days: CL 0.387 → 0.5; EL 0.484 → 0.5.
  ['7 left 12 Mar', { lastWorkingDate: '2026-03-12' }, 0.5, 0.5, 0.5],
  [
    '8 intern, no probation',
    { joiningDate: '2025-12-01', hasProbation: false, confirmationDate: null },
    1,
    1,
    0,
  ],
  ['9 joins 2 Apr', { joiningDate: '2026-04-02', confirmationDate: null }, 0, 0, 0],
  // No probation (fixed term): EL from joining.
  [
    '10 fixed term, no probation',
    { joiningDate: '2025-06-01', hasProbation: false, confirmationDate: null },
    1,
    1,
    1.25,
  ],
];

describe('monthly accrual: the 10-person March sample (done-when #1)', () => {
  it.each(sample)('%s', (_who, f, cl, sl, el) => {
    expect(credit(CL, f)).toBe(cl);
    expect(credit(SL, f)).toBe(sl);
    // Person 8 is an intern: EL doesn't apply to them (checked on the type), the rule alone gives 1.25.
    if (!_who.startsWith('8')) expect(credit(EL, f)).toBe(el);
  });

  it('says why', () => {
    expect(monthlyAccrual(CL, facts({}), '2026-03').note).toBe('March accrual: 31 of 31 days');
    expect(monthlyAccrual(CL, facts({ joiningDate: '2026-03-16' }), '2026-03').note).toBe(
      'March accrual: 16 of 31 days (joined 16 Mar)',
    );
    expect(
      monthlyAccrual(
        EL,
        facts({ joiningDate: '2025-09-20', confirmationDate: '2026-03-20' }),
        '2026-03',
      ).note,
    ).toBe('March accrual: 12 of 31 days (confirmed 20 Mar)');
    expect(monthlyAccrual(EL, facts({ confirmationDate: null }), '2026-03').note).toBe(
      'March: on probation',
    );
  });

  it('February and leap years', () => {
    expect(monthlyAccrual(CL, facts({ joiningDate: '2026-02-15' }), '2026-02').amount).toBe(50);
    expect(monthlyAccrual(CL, facts({ joiningDate: '2028-02-15' }), '2028-02').amount).toBe(50);
    expect(monthlyAccrual(EL, facts({}), '2026-02').amount).toBe(125);
  });
});

describe('defaults and year end', () => {
  it('EL is for permanent and fixed-term staff; retainers and consultants get no leave', () => {
    const el = defaultLeaveTypes.find((t) => t.code === 'EL')!;
    expect(el.appliesTo.engagementTypes).toEqual(['permanent', 'fixed_term']);
    for (const t of defaultLeaveTypes) {
      expect(t.appliesTo.engagementTypes).not.toContain('consultant');
      expect(t.appliesTo.engagementTypes).not.toContain('retainer');
    }
  });

  it('carries up to the cap and lapses the rest', () => {
    expect(yearEnd(3500, 3000)).toEqual({ carry: 3000, lapse: 500 });
    expect(yearEnd(400, 0)).toEqual({ carry: 0, lapse: 400 });
    expect(yearEnd(400, null)).toEqual({ carry: 400, lapse: 0 });
    expect(yearEnd(-100, 0)).toEqual({ carry: -100, lapse: 0 });
    expect(yearEnd(0, 3000)).toEqual({ carry: 0, lapse: 0 });
  });

  it('rounds to the nearest half day', () => {
    expect(roundToHalfDay(24)).toBe(0);
    expect(roundToHalfDay(25)).toBe(50);
    expect(roundToHalfDay(74)).toBe(50);
    expect(roundToHalfDay(75)).toBe(100);
  });
});
