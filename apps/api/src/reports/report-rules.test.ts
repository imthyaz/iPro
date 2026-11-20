import { describe, expect, it } from 'vitest';
import {
  attrition,
  exitKindOf,
  monthEnds,
  onHeadcount,
  percent,
  type EngagementFact,
} from './report-rules.js';

// The hand-calculated set (decision #93), January to June 2026.
const f = (
  personId: string,
  joiningDate: string,
  status: EngagementFact['status'],
  lastWorkingDate: string | null = null,
  exitKind: EngagementFact['exitKind'] = null,
): EngagementFact => ({ personId, joiningDate, status, lastWorkingDate, exitKind });
const facts = [
  f('A', '2024-01-08', 'active'),
  f('B', '2024-03-01', 'active'),
  f('C', '2026-02-10', 'active'),
  f('D', '2026-04-15', 'active'),
  f('E', '2023-06-01', 'exited', '2026-03-15', 'resignation'),
  f('F', '2024-05-01', 'exited', '2026-05-31', 'termination'),
  f('G', '2025-01-01', 'on_notice', '2026-08-31'),
  f('H', '2026-12-01', 'pre_joining'),
];

describe('headcount on a day', () => {
  it('counts people joined and not yet past their last day', () => {
    expect(facts.filter((e) => onHeadcount(e, '2026-03-31')).map((e) => e.personId)).toEqual([
      'A',
      'B',
      'C',
      'F',
      'G',
    ]);
    // The last working day still counts.
    expect(onHeadcount(facts[5]!, '2026-05-31')).toBe(true);
    expect(onHeadcount(facts[5]!, '2026-06-01')).toBe(false);
  });
});

describe('attrition (decision #93)', () => {
  it('leavers ÷ average month-end headcount, for the period and annualised', () => {
    // Month ends: 31 Jan 5, 28 Feb 6, 31 Mar 5, 30 Apr 6, 31 May 6, 30 Jun 5 → average 5.5.
    const a = attrition(facts, '2026-01-01', '2026-06-30');
    expect(a.monthEnds.map((m) => m.headcount)).toEqual([5, 6, 5, 6, 6, 5]);
    expect(a).toMatchObject({
      leavers: 2,
      voluntary: 1,
      involuntary: 1,
      unknown: 0,
      averageHeadcount: 5.5,
      rate: 36.4, // 2 ÷ 5.5
      annualised: 72.7, // 36.36 × 12 ÷ 6
    });
  });

  it('a range inside one month uses its last day', () => {
    expect(monthEnds('2026-03-01', '2026-03-20')).toEqual(['2026-03-20']);
    expect(monthEnds('2026-01-15', '2026-03-31')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
  });
});

describe('exit kinds and percentages', () => {
  it('reads the exit case first, then the engagement', () => {
    expect(exitKindOf('termination', '2026-01-01', null)).toBe('termination');
    expect(exitKindOf(null, '2026-01-01', 'resigned')).toBe('resignation');
    expect(exitKindOf(null, null, 'probation_terminated')).toBe('termination');
    expect(exitKindOf(null, null, 'internship_completed')).toBe('end_of_term');
    expect(exitKindOf(null, null, null)).toBeNull();
  });

  it('rounds to one place and never divides by zero', () => {
    expect(percent(3, 40)).toBe(7.5);
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(1, 0)).toBe(0);
  });
});
