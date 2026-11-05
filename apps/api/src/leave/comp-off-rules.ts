/**
 * Comp-off rules with no database (decisions #71, #73, #76). Amounts are hundredths of a day.
 *
 * Each grant is usable until a date. Leave taken comes out of the grant that expires first, so what
 * is left of the balance is held by the grants that expire last. Days credited another way (an
 * import or an HR adjustment) don't expire; they are what is left above the grants.
 */
import { toDays } from '@ipro/shared';
import { addDays } from '../common/effective-dating.js';

export interface LiveGrant {
  id: string;
  amount: number;
  validUntil: string;
}

/** The last day a grant can be used: N days after it is granted, or null when it never expires. */
export function validUntil(grantedOn: string, expiresAfterDays: number | null): string | null {
  return expiresAfterDays === null ? null : addDays(grantedOn, expiresAfterDays);
}

/** What each live grant still holds of a balance: the latest-expiring grants keep theirs first. */
export function heldByGrant(grants: LiveGrant[], balance: number): Map<string, number> {
  const held = new Map<string, number>();
  let rest = Math.max(0, balance);
  for (const g of [...grants].sort((a, b) => b.validUntil.localeCompare(a.validUntil))) {
    const keep = Math.min(g.amount, rest);
    held.set(g.id, keep);
    rest -= keep;
  }
  return new Map(grants.map((g) => [g.id, held.get(g.id)!]));
}

/** The part of a balance still usable on a day: grants that ran out before it don't count. */
export function usableBy(grants: LiveGrant[], balance: number, day: string): number {
  const held = heldByGrant(grants, balance);
  let lost = 0;
  for (const g of grants) if (g.validUntil < day) lost += held.get(g.id)!;
  return Math.max(0, balance - lost);
}

const short = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const shortDate = (iso: string) => short.format(new Date(`${iso}T00:00:00Z`));

/** The ledger note for an expiry: which day it was for, when it ran out, how much had been used. */
export function expiryNote(
  workedOn: string,
  until: string,
  granted: number,
  expiring: number,
): string {
  const base = `Comp-off for ${shortDate(workedOn)} expired after ${shortDate(until)}`;
  if (expiring >= granted) return base;
  const unit = granted === 100 ? 'day' : 'days';
  return `${base}; ${toDays(granted - expiring)} of ${toDays(granted)} ${unit} had been used`;
}
