/**
 * The monthly attendance and loss-of-pay export (slice 7c; decision #77), with no database so a
 * month can be counted by hand. Amounts are hundredths of a day.
 *
 * A working day is covered by approved leave first (paid, or loss of pay); the rest of it is worked
 * if the person was present, WFH or at a client site. An absent working day with no leave is a full
 * day of loss of pay; a half day with no leave is half a day. Weekly offs and holidays are paid.
 */
import type { AttendanceStatus, WorkMode } from '@ipro/shared';

export interface PayrollDayInput {
  day: string;
  /** Joined on or before the day and not past the last working day. */
  employed: boolean;
  working: boolean;
  holiday: boolean;
  /** The day as built (a stale "leave" row whose leave was withdrawn already left out), or null. */
  status: AttendanceStatus | null;
  mode: WorkMode | null;
  /** Approved leave on the day: paid, and loss of pay (0, 50 or 100 each). */
  paidLeave: number;
  unpaidLeave: number;
}

export interface MonthTotals {
  employed: number;
  office: number;
  wfh: number;
  clientSite: number;
  paidLeave: number;
  lopLeave: number;
  lopAbsent: number;
  weeklyOff: number;
  holiday: number;
  /** Each day with loss of pay and why: every number explains itself. */
  lopDays: { date: string; amount: number; why: string }[];
}

export const emptyTotals = (): MonthTotals => ({
  employed: 0,
  office: 0,
  wfh: 0,
  clientSite: 0,
  paidLeave: 0,
  lopLeave: 0,
  lopAbsent: 0,
  weeklyOff: 0,
  holiday: 0,
  lopDays: [],
});

const WORKED: Partial<Record<AttendanceStatus, WorkMode>> = {
  present: 'office',
  wfh: 'wfh',
  client_site: 'client_site',
};

/** Adds one day to a month's totals. */
export function addDay(totals: MonthTotals, d: PayrollDayInput): MonthTotals {
  if (!d.employed) return totals;
  totals.employed += 100;
  const unpaid = Math.min(100, d.unpaidLeave);
  const paid = Math.min(100 - unpaid, d.paidLeave);
  totals.paidLeave += paid;
  totals.lopLeave += unpaid;
  const reasons: string[] = [];
  let lop = unpaid;
  if (unpaid) reasons.push(unpaid === 100 ? 'Loss-of-pay leave' : 'Half day of loss-of-pay leave');
  const rest = 100 - paid - unpaid;
  if (rest > 0) {
    if (!d.working) {
      if (d.holiday) totals.holiday += rest;
      else totals.weeklyOff += rest;
    } else {
      const worked = (mode: WorkMode | null, amount: number) => {
        if (mode === 'wfh') totals.wfh += amount;
        else if (mode === 'client_site') totals.clientSite += amount;
        else totals.office += amount;
      };
      const mode = d.status ? WORKED[d.status] : undefined;
      if (mode) {
        worked(mode, rest);
      } else if (d.status === 'half_day') {
        // Half a day worked; with no leave for the other half, that half is loss of pay.
        if (rest === 100) {
          worked(d.mode, 50);
          totals.lopAbsent += 50;
          lop += 50;
          reasons.push('Half day, no leave for the other half');
        } else {
          worked(d.mode, rest);
        }
      } else {
        totals.lopAbsent += rest;
        lop += rest;
        reasons.push(
          d.status === null
            ? 'No attendance recorded, no leave'
            : rest === 100
              ? 'Absent, no leave'
              : 'Absent for the other half, no leave',
        );
      }
    }
  }
  if (lop > 0) totals.lopDays.push({ date: d.day, amount: lop, why: reasons.join('; ') });
  return totals;
}

export const lopOf = (t: MonthTotals) => t.lopLeave + t.lopAbsent;
/** Days paid for: the days employed in the month less loss of pay. */
export const payableOf = (t: MonthTotals) => t.employed - lopOf(t);

/** A CSV cell: quoted when needed, and never read as a formula by a spreadsheet. */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
