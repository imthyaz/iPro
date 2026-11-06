import { describe, expect, it } from 'vitest';
import {
  actualUnits,
  todayStatus,
  weekCompliance,
  type ComplianceDay,
} from './compliance-rules.js';

// Monday 2 Nov 2026 to Sunday 8 Nov; Saturday and Sunday off.
const day = (i: number, extra: Partial<ComplianceDay> = {}): ComplianceDay => ({
  date: `2026-11-0${2 + i}`,
  working: i < 5,
  onLeave: false,
  planned: null,
  actualStatus: null,
  actualMode: null,
  ...extra,
});

describe('hybrid compliance (spec: planned vs actual; decision #78)', () => {
  it('counts an office day 1 and a half day in the office 0.5; nothing else counts', () => {
    expect(actualUnits('office', 'present', 'office')).toBe(100);
    expect(actualUnits('office', 'half_day', 'office')).toBe(50);
    expect(actualUnits('office', 'half_day', null)).toBe(50);
    expect(actualUnits('office', 'wfh', 'wfh')).toBe(0);
    expect(actualUnits('office', 'client_site', 'client_site')).toBe(0);
    expect(actualUnits('office', 'leave', null)).toBe(0);
    expect(actualUnits('client_site', 'client_site', 'client_site')).toBe(100);
    expect(actualUnits('client_site', 'present', 'office')).toBe(0);
  });

  it('compares a week planned with what happened, day by day', () => {
    const week = [
      day(0, { planned: 'office', actualStatus: 'present', actualMode: 'office' }),
      day(1, { planned: 'office', actualStatus: 'half_day', actualMode: 'office' }),
      day(2, { planned: 'office', actualStatus: 'wfh', actualMode: 'wfh' }),
      day(3, { planned: 'wfh', actualStatus: 'present', actualMode: 'office' }),
      day(4, { onLeave: true, actualStatus: 'leave' }),
      day(5),
      day(6),
    ];
    const result = weekCompliance('office', 3, week);
    // Four days available; target 3. Planned 3; actual 1 + 0.5 + 1 (came in on a WFH day) = 2.5.
    expect(result).toMatchObject({ target: 3, planned: 3, actual: 2.5, met: false });
    expect(result.days.map((d) => d.why)).toEqual([
      'Planned office, in the office',
      'Planned office, half a day in the office',
      'Planned office, worked from home',
      'Planned WFH, in the office',
      'On leave',
      'Weekly off or holiday',
      'Weekly off or holiday',
    ]);
  });

  it('lowers the target for leave and meets it with enough office days', () => {
    const week = [0, 1, 2, 3, 4, 5, 6].map((i) =>
      day(
        i,
        i < 3 ? { onLeave: true } : i < 5 ? { actualStatus: 'present', actualMode: 'office' } : {},
      ),
    );
    expect(weekCompliance('office', 3, week)).toMatchObject({ target: 2, actual: 2, met: true });
  });

  it('a day not yet over or not recorded shows as no attendance', () => {
    const result = weekCompliance('office', 3, [day(0, { planned: 'office' })]);
    expect(result.days[0]!.why).toBe('Planned office, no attendance recorded');
  });

  it('says where each person is today', () => {
    expect(todayStatus({ working: true, leave: null, status: 'present', mode: 'office' })).toBe(
      'office',
    );
    expect(todayStatus({ working: true, leave: null, status: 'wfh', mode: 'wfh' })).toBe('wfh');
    expect(todayStatus({ working: true, leave: 'full', status: null, mode: null })).toBe('leave');
    expect(todayStatus({ working: true, leave: 'first', status: null, mode: null })).toBe(
      'not_checked_in',
    );
    expect(todayStatus({ working: false, leave: null, status: null, mode: null })).toBe('off');
    expect(todayStatus({ working: false, leave: null, status: 'present', mode: 'office' })).toBe(
      'office',
    );
    expect(todayStatus({ working: true, leave: null, status: 'absent', mode: null })).toBe(
      'absent',
    );
    expect(todayStatus({ working: true, leave: null, status: null, mode: null })).toBe(
      'not_checked_in',
    );
  });
});
