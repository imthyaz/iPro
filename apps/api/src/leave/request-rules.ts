/**
 * Leave request rules with no database (spec workflow 4; decisions #71, #74), so they can be
 * tested on their own. Amounts are hundredths of a day: a full day is 100, a half day 50.
 */
import { addDays } from '../common/effective-dating.js';

export type Half = 'full' | 'first' | 'second';

export interface PlannedDay {
  day: string;
  half: Half;
  amount: number;
}

/**
 * The days a request covers. Weekly offs and holidays aren't counted (the sandwich rule is off,
 * decision #71) unless the type counts calendar days (e.g. maternity). The first day may start in
 * the afternoon and the last may end at midday; a single day is a full day, a morning or an
 * afternoon.
 */
export function planDays(input: {
  from: string;
  to: string;
  startHalf: 'full' | 'second';
  endHalf: 'full' | 'first';
  countsCalendarDays: boolean;
  isWorking: (day: string) => boolean;
}): PlannedDay[] {
  if (input.to < input.from) throw new RangeError('The leave ends before it starts');
  const single = input.from === input.to;
  if (single && input.startHalf === 'second' && input.endHalf === 'first') {
    throw new RangeError('A single day is a full day, a morning or an afternoon');
  }
  const days: PlannedDay[] = [];
  for (let day = input.from; day <= input.to; day = addDays(day, 1)) {
    if (!input.countsCalendarDays && !input.isWorking(day)) continue;
    let half: Half = 'full';
    if (day === input.from && input.startHalf === 'second') half = 'second';
    if (day === input.to && input.endHalf === 'first') half = 'first';
    days.push({ day, half, amount: half === 'full' ? 100 : 50 });
  }
  return days;
}

export const totalOf = (days: readonly { amount: number }[]) =>
  days.reduce((sum, d) => sum + d.amount, 0);

/**
 * Splits days between the asked type and loss of pay when the balance is short (decision #74):
 * the earliest days use the balance, the rest are loss of pay. A full day can split into a half of
 * each.
 */
export function splitShortfall(
  days: readonly PlannedDay[],
  available: number,
): { paid: PlannedDay[]; lop: PlannedDay[] } {
  const paid: PlannedDay[] = [];
  const lop: PlannedDay[] = [];
  let left = Math.max(0, Math.floor(available / 50) * 50);
  for (const d of days) {
    if (left >= d.amount) {
      paid.push(d);
      left -= d.amount;
    } else if (left === 50 && d.half === 'full') {
      paid.push({ day: d.day, half: 'first', amount: 50 });
      lop.push({ day: d.day, half: 'second', amount: 50 });
      left = 0;
    } else {
      lop.push(d);
    }
  }
  return { paid, lop };
}

/** Do two day-parts overlap? Full overlaps everything; the two halves don't overlap each other. */
export const halvesOverlap = (a: Half, b: Half) => a === 'full' || b === 'full' || a === b;
