/**
 * Hybrid planning rules with no database (spec workflow 6; decision #78), so a week can be checked
 * by hand.
 */
import type { WorkMode } from '@ipro/shared';
import { addDays } from '../common/effective-dating.js';

/** A day is locked at 18:00 India time the day before (decision #78). */
export function cutoffOf(day: string): Date {
  return new Date(`${addDays(day, -1)}T18:00:00+05:30`);
}

export const beforeCutoff = (day: string, now: Date) => now.getTime() < cutoffOf(day).getTime();

/** ISO weekday, Monday 1 to Sunday 7. */
export const isoWeekday = (day: string) => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/** The Monday of a day's week (weeks run Monday to Sunday). */
export const mondayOf = (day: string) => addDays(day, 1 - isoWeekday(day));

export interface FitPolicy {
  requiredMode: 'office' | 'client_site';
  requiredDays: number;
  anchorDayRequired: boolean;
  allowedModes: WorkMode[];
}

export interface FitDay {
  date: string;
  working: boolean;
  /** A full day of leave, approved or asked for. */
  onLeave: boolean;
  mode: WorkMode | null;
}

export interface WeekFit {
  /** Required days this week: the policy's, lowered when leave and holidays leave fewer days. */
  target: number;
  booked: number;
  fits: boolean;
  /** Why it is below policy, in plain words. */
  reasons: string[];
  /** Days booked in a mode the policy doesn't allow (refused outright). */
  notAllowed: string[];
}

const short = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
export const dayLabel = (iso: string) =>
  short.format(new Date(`${iso}T00:00:00Z`)).replace(',', '');

const modeWords = { office: 'office', client_site: 'client-site' } as const;

/**
 * Checks a week against the policy: enough days in the required mode on the days available
 * (working, not on leave), and, for office policies, the team's anchor day in the office.
 */
export function weekFit(policy: FitPolicy, days: FitDay[], anchorWeekday: number | null): WeekFit {
  const available = days.filter((d) => d.working && !d.onLeave);
  const target = Math.min(policy.requiredDays, available.length);
  const booked = available.filter((d) => d.mode === policy.requiredMode).length;
  const reasons: string[] = [];
  if (booked < target) {
    reasons.push(
      `${booked} of ${target} ${modeWords[policy.requiredMode]} ${target === 1 ? 'day' : 'days'} booked`,
    );
  }
  if (policy.anchorDayRequired && policy.requiredMode === 'office' && anchorWeekday !== null) {
    const anchor = available.find((d) => isoWeekday(d.date) === anchorWeekday);
    if (anchor && anchor.mode !== 'office') {
      reasons.push(`The team’s anchor day (${dayLabel(anchor.date)}) isn’t an office day`);
    }
  }
  const notAllowed = days
    .filter((d) => d.mode !== null && !policy.allowedModes.includes(d.mode))
    .map((d) => d.date);
  return { target, booked, fits: reasons.length === 0, reasons, notAllowed };
}
