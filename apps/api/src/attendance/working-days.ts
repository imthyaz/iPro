import { addDays } from '../common/effective-dating.js';

/** ISO weekday of a business date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(isoDate: string): number {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Decides whether a date is a working day for one person. */
export type WorkingDayRule = (isoDate: string) => boolean;

/**
 * A person's working days: not one of their shift's weekly offs on that date, and not a holiday.
 * Holiday calendars arrive with slice 6; until then `isHoliday` is always false.
 */
export function workingDayRule(
  weeklyOffsOn: (isoDate: string) => readonly number[],
  isHoliday: (isoDate: string) => boolean = () => false,
): WorkingDayRule {
  return (isoDate) => !weeklyOffsOn(isoDate).includes(isoWeekday(isoDate)) && !isHoliday(isoDate);
}

/** The date `count` working days after `start` (start itself is not counted). */
export function addWorkingDays(start: string, count: number, isWorking: WorkingDayRule): string {
  if (count < 0) throw new Error('count must not be negative');
  let date = start;
  let remaining = count;
  // A shift has at least one working day a week (database check), so this always ends.
  while (remaining > 0) {
    date = addDays(date, 1);
    if (isWorking(date)) remaining -= 1;
  }
  return date;
}

/** Working days after `from` up to and including `to`; 0 when `to` is not after `from`. */
export function workingDaysBetween(from: string, to: string, isWorking: WorkingDayRule): number {
  let count = 0;
  for (let date = addDays(from, 1); date <= to; date = addDays(date, 1)) {
    if (isWorking(date)) count += 1;
  }
  return count;
}
