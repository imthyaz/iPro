import { describe, expect, it } from 'vitest';
import { describeWorkingWeek } from './shifts.js';

describe('describeWorkingWeek', () => {
  it('reads the week from the day after the days off', () => {
    expect(describeWorkingWeek([6, 7])).toBe('Mon–Fri');
    expect(describeWorkingWeek([5, 6])).toBe('Sun–Thu');
    expect(describeWorkingWeek([7])).toBe('Mon–Sat');
    expect(describeWorkingWeek([1])).toBe('Tue–Sun');
  });

  it('lists days when the week is not one run, and handles the extremes', () => {
    expect(describeWorkingWeek([2, 4, 6, 7])).toBe('Mon, Wed, Fri');
    expect(describeWorkingWeek([])).toBe('Every day');
  });
});
