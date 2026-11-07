/**
 * Exit rules with no database (spec workflow 7; decision #80), so they can be checked by hand.
 */
import { addDays } from '../common/effective-dating.js';

/** The notice runs for its days after the day of resignation; the last of them is the default last day. */
export const noticeLastDay = (resignationDate: string, noticeDays: number) =>
  addDays(resignationDate, noticeDays);

/** On probation until confirmed, when the engagement has a probation at all. */
export const onProbation = (e: {
  probationEndDate: string | null;
  confirmationDate: string | null;
}) => e.probationEndDate !== null && e.confirmationDate === null;

const long = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
export const longDate = (iso: string) => long.format(new Date(`${iso}T00:00:00Z`));

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * A last working day is from the resignation up to the end of the notice. Earlier than the end of
 * the notice by some days, it needs a buyout or a waiver (approved by HR head, decision #80).
 */
export function checkLastDay(
  resignationDate: string,
  noticeDay: string,
  lastDay: string,
): { earlyBy: number } | { problem: string } {
  if (lastDay < resignationDate) {
    return { problem: 'The last working day can’t be before the resignation' };
  }
  if (lastDay > noticeDay) {
    return {
      problem: `The last working day can be up to ${longDate(noticeDay)}, the end of the notice period`,
    };
  }
  return { earlyBy: daysBetween(lastDay, noticeDay) };
}
