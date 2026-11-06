import { describe, expect, it } from 'vitest';
import { beforeCutoff, cutoffOf, mondayOf, weekFit, type FitDay } from './hybrid-rules.js';

const hybrid = {
  requiredMode: 'office' as const,
  requiredDays: 3,
  anchorDayRequired: true,
  allowedModes: ['office', 'wfh', 'client_site'] as ('office' | 'wfh' | 'client_site')[],
};
// Monday 16 Nov 2026 to Sunday 22 Nov; Saturday and Sunday off.
const week = (modes: (string | null)[], extra: Partial<Record<number, Partial<FitDay>>> = {}) =>
  Array.from({ length: 7 }, (_, i): FitDay => ({
    date: `2026-11-${16 + i}`,
    working: i < 5,
    onLeave: false,
    mode: (modes[i] ?? null) as FitDay['mode'],
    ...extra[i],
  }));

describe('hybrid planning (spec workflow 6; decision #78)', () => {
  it('locks a day at 18:00 India time the day before', () => {
    expect(cutoffOf('2026-11-17').toISOString()).toBe('2026-11-16T12:30:00.000Z');
    expect(beforeCutoff('2026-11-17', new Date('2026-11-16T12:29:59Z'))).toBe(true);
    expect(beforeCutoff('2026-11-17', new Date('2026-11-16T12:30:00Z'))).toBe(false);
  });

  it('weeks start on Monday', () => {
    expect(mondayOf('2026-11-19')).toBe('2026-11-16');
    expect(mondayOf('2026-11-16')).toBe('2026-11-16');
    expect(mondayOf('2026-11-22')).toBe('2026-11-16');
  });

  it('fits with the office days booked and the anchor day in office', () => {
    const fit = weekFit(hybrid, week(['office', 'wfh', 'office', 'office', 'wfh']), 3);
    expect(fit).toEqual({ target: 3, booked: 3, fits: true, reasons: [], notAllowed: [] });
  });

  it('is below policy with too few office days, or the anchor day missed', () => {
    expect(weekFit(hybrid, week(['office', 'wfh', 'office', 'wfh', 'wfh']), 3)).toMatchObject({
      booked: 2,
      fits: false,
      reasons: ['2 of 3 office days booked'],
    });
    expect(weekFit(hybrid, week(['office', 'office', 'wfh', 'office', 'wfh']), 3)).toMatchObject({
      booked: 3,
      fits: false,
      reasons: ['The team’s anchor day (Wed 18 Nov) isn’t an office day'],
    });
    // No anchor set for the team: only the count matters.
    expect(weekFit(hybrid, week(['office', 'office', 'wfh', 'office', 'wfh']), null).fits).toBe(
      true,
    );
  });

  it('lowers the target for leave and holidays, and skips an anchor day on leave', () => {
    // Three days of leave leave two working days: two office days are enough.
    const leave = week(['office', 'office', null, null, null], {
      2: { onLeave: true },
      3: { onLeave: true },
      4: { working: false },
    });
    expect(weekFit(hybrid, leave, 3)).toMatchObject({ target: 2, booked: 2, fits: true });
  });

  it('refuses a mode the policy doesn’t allow', () => {
    const onSite = {
      ...hybrid,
      requiredMode: 'client_site' as const,
      requiredDays: 5,
      anchorDayRequired: false,
      allowedModes: ['client_site' as const],
    };
    const fit = weekFit(
      onSite,
      week(['client_site', 'wfh', 'client_site', 'client_site', 'client_site']),
      3,
    );
    expect(fit.notAllowed).toEqual(['2026-11-17']);
    expect(fit.reasons).toEqual(['4 of 5 client-site days booked']);
  });

  it('a policy with no required days always fits', () => {
    const remote = { ...hybrid, requiredDays: 0, anchorDayRequired: false };
    expect(weekFit(remote, week([]), 3)).toMatchObject({ target: 0, fits: true });
  });
});
