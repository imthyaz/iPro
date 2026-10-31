import { describe, expect, it } from 'vitest';
import { addWorkingDays, isoWeekday, workingDayRule, workingDaysBetween } from './working-days.js';

const monToFri = workingDayRule(() => [6, 7]);
const sunToThu = workingDayRule(() => [5, 6]);

describe('isoWeekday', () => {
  it('numbers Monday 1 to Sunday 7', () => {
    expect(isoWeekday('2026-11-02')).toBe(1); // Monday
    expect(isoWeekday('2026-11-06')).toBe(5); // Friday
    expect(isoWeekday('2026-11-08')).toBe(7); // Sunday
  });
});

describe('working days by shift', () => {
  it('Mon–Fri: Friday is a working day, Saturday and Sunday are not', () => {
    expect(monToFri('2026-11-06')).toBe(true);
    expect(monToFri('2026-11-07')).toBe(false);
    expect(monToFri('2026-11-08')).toBe(false);
  });

  it('Sun–Thu (Middle East customers): Sunday works, Friday and Saturday are off', () => {
    expect(sunToThu('2026-11-08')).toBe(true);
    expect(sunToThu('2026-11-06')).toBe(false);
    expect(sunToThu('2026-11-07')).toBe(false);
  });

  it('holidays are not working days', () => {
    const withHoliday = workingDayRule(
      () => [6, 7],
      (d) => d === '2026-11-04',
    );
    expect(withHoliday('2026-11-04')).toBe(false);
  });

  it('a mid-week shift change applies from its date', () => {
    const switching = workingDayRule((d) => (d < '2026-11-08' ? [6, 7] : [5, 6]));
    expect(switching('2026-11-06')).toBe(true); // still Mon–Fri
    expect(switching('2026-11-13')).toBe(false); // Friday on Sun–Thu
  });
});

describe('addWorkingDays', () => {
  it('3 working days after a Thursday is the next Tuesday on Mon–Fri', () => {
    expect(addWorkingDays('2026-11-05', 3, monToFri)).toBe('2026-11-10');
  });

  it('3 working days after a Wednesday is the next Sunday on Sun–Thu', () => {
    expect(addWorkingDays('2026-11-04', 3, sunToThu)).toBe('2026-11-09');
  });

  it('0 days is the start date', () => {
    expect(addWorkingDays('2026-11-07', 0, monToFri)).toBe('2026-11-07');
  });
});

describe('workingDaysBetween', () => {
  it('counts working days after the start up to the end', () => {
    expect(workingDaysBetween('2026-11-06', '2026-11-10', monToFri)).toBe(2);
    expect(workingDaysBetween('2026-11-06', '2026-11-10', sunToThu)).toBe(3);
    expect(workingDaysBetween('2026-11-10', '2026-11-06', monToFri)).toBe(0);
  });
});
