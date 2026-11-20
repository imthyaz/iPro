/**
 * Definitions behind the H12 reports (decision #93), kept pure so they can be checked by hand.
 */
export interface EngagementFact {
  personId: string;
  status: 'offered' | 'pre_joining' | 'active' | 'on_notice' | 'exited' | 'withdrawn';
  joiningDate: string;
  lastWorkingDate: string | null;
  exitKind: 'resignation' | 'termination' | 'end_of_term' | null;
}

const NEVER_JOINED = new Set(['offered', 'pre_joining', 'withdrawn']);

/** On the books that day: joined by then and not yet past the last working day. */
export function onHeadcount(e: EngagementFact, day: string): boolean {
  return (
    !NEVER_JOINED.has(e.status) &&
    e.joiningDate <= day &&
    (e.lastWorkingDate === null || e.lastWorkingDate >= day)
  );
}

export const joinedIn = (e: EngagementFact, from: string, to: string) =>
  !NEVER_JOINED.has(e.status) && e.joiningDate >= from && e.joiningDate <= to;

/** Left in the range: the last working day fell in it and the exit has happened. */
export const leftIn = (e: EngagementFact, from: string, to: string) =>
  e.status === 'exited' &&
  e.lastWorkingDate !== null &&
  e.lastWorkingDate >= from &&
  e.lastWorkingDate <= to;

/** The last day of each month that ends inside the range; just `to` when none does. */
export function monthEnds(from: string, to: string): string[] {
  const ends: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  for (;;) {
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (end > to) break;
    if (end >= from) ends.push(end);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return ends.length ? ends : [to];
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const percent = (part: number, whole: number) =>
  whole > 0 ? round1((part / whole) * 100) : 0;

/**
 * Attrition (decision #93): leavers ÷ the average of month-end headcounts in the range, as a % for
 * the period, and annualised by the number of months (12 ÷ months).
 */
export function attrition(
  facts: EngagementFact[],
  from: string,
  to: string,
): {
  leavers: number;
  voluntary: number;
  involuntary: number;
  unknown: number;
  monthEnds: { date: string; headcount: number }[];
  averageHeadcount: number;
  rate: number;
  annualised: number;
} {
  const ends = monthEnds(from, to).map((date) => ({
    date,
    headcount: facts.filter((e) => onHeadcount(e, date)).length,
  }));
  const average = ends.reduce((n, e) => n + e.headcount, 0) / ends.length;
  const left = facts.filter((e) => leftIn(e, from, to));
  const raw = average > 0 ? (left.length / average) * 100 : 0;
  return {
    leavers: left.length,
    voluntary: left.filter((e) => e.exitKind === 'resignation').length,
    involuntary: left.filter((e) => e.exitKind === 'termination' || e.exitKind === 'end_of_term')
      .length,
    unknown: left.filter((e) => e.exitKind === null).length,
    monthEnds: ends,
    averageHeadcount: round1(average),
    rate: round1(raw),
    annualised: round1((raw * 12) / ends.length),
  };
}

/** How an exit happened, from its exit case or, for older records, the engagement itself. */
export function exitKindOf(
  caseKind: string | null,
  resignationDate: string | null,
  exitReason: string | null,
): EngagementFact['exitKind'] {
  if (caseKind === 'resignation' || caseKind === 'termination' || caseKind === 'end_of_term') {
    return caseKind;
  }
  if (resignationDate) return 'resignation';
  if (exitReason === 'terminated' || exitReason === 'probation_terminated') return 'termination';
  if (exitReason === 'internship_completed' || exitReason === 'internship_break')
    return 'end_of_term';
  return null;
}

/** Attendance statuses that are scheduled working days (holidays and weekly offs aren't). */
export const WORKING_STATUSES = ['present', 'absent', 'half_day', 'leave', 'wfh', 'client_site'];
