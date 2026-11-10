/**
 * Who gets a notification by which channel (decision #87). Teams is the default; email goes to
 * pre-joiners (no Teams yet), to anyone who asked for a copy, and to anyone Teams can't reach.
 */
export type Channel = 'teams' | 'email';

export function channelsFor(recipient: { preJoiner: boolean; emailCopy: boolean }): Channel[] {
  if (recipient.preJoiner) return ['email'];
  return recipient.emailCopy ? ['teams', 'email'] : ['teams'];
}

/** Waits after each failed attempt; after the last one the delivery is given up as failed. */
export const RETRY_MINUTES = [1, 5, 30, 120] as const;

export function nextAttempt(attempts: number, now: Date): Date | null {
  const wait = RETRY_MINUTES[attempts - 1];
  return wait === undefined ? null : new Date(now.getTime() + wait * 60_000);
}

/**
 * Years completed on `today` for someone who joined on `joiningDate`, or null when today isn't the
 * anniversary (or it's the first year). 29 February anniversaries fall on 28 February otherwise.
 */
export function anniversaryYears(joiningDate: string, today: string): number | null {
  const [jy, jm, jd] = joiningDate.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  const years = ty - jy;
  if (years < 1) return null;
  const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const day = jm === 2 && jd === 29 && !leap(ty) ? 28 : jd;
  return tm === jm && td === day ? years : null;
}

export const ordinalYears = (n: number) => (n === 1 ? '1 year' : `${n} years`);
