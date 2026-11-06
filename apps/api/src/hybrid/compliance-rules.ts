/**
 * Hybrid compliance and Team today (slice 8b; decision #78), with no database so a week can be
 * checked by hand. Amounts are hundredths of a day; weeks are reported in days.
 */
import type { AttendanceStatus, WorkMode } from '@ipro/shared';

export type RequiredMode = 'office' | 'client_site';

export interface ComplianceDay {
  date: string;
  working: boolean;
  /** A full day of approved leave. */
  onLeave: boolean;
  /** What was booked (confirmed or approved), if anything. */
  planned: WorkMode | null;
  actualStatus: AttendanceStatus | null;
  actualMode: WorkMode | null;
}

/**
 * What a day counts towards the policy (decision #78): a day in the required place is 1, a half day
 * there 0.5; WFH, the other place and leave count nothing.
 */
export function actualUnits(
  required: RequiredMode,
  status: AttendanceStatus | null,
  mode: WorkMode | null,
): number {
  if (required === 'office') {
    if (status === 'present') return 100;
    if (status === 'half_day' && (mode === 'office' || mode === null)) return 50;
    return 0;
  }
  if (status === 'client_site') return 100;
  if (status === 'half_day' && mode === 'client_site') return 50;
  return 0;
}

const placeWords: Record<WorkMode, string> = {
  office: 'office',
  wfh: 'WFH',
  client_site: 'client site',
};

function actualWords(status: AttendanceStatus | null, mode: WorkMode | null): string {
  switch (status) {
    case 'present':
      return 'in the office';
    case 'wfh':
      return 'worked from home';
    case 'client_site':
      return 'at a client site';
    case 'half_day':
      return mode === 'wfh'
        ? 'half a day from home'
        : mode === 'client_site'
          ? 'half a day at a client site'
          : 'half a day in the office';
    case 'absent':
      return 'absent';
    case 'leave':
      return 'on leave';
    default:
      return 'no attendance recorded';
  }
}

export interface WeekResult {
  /** Required days this week, lowered for leave and holidays. */
  target: number;
  /** Days booked in the required place. */
  planned: number;
  /** Days there, from attendance. */
  actual: number;
  met: boolean;
  days: { date: string; planned: WorkMode | null; units: number; why: string }[];
}

/** A week as planned against what happened: the "why" for every compliance figure. */
export function weekCompliance(
  required: RequiredMode,
  requiredDays: number,
  days: ComplianceDay[],
): WeekResult {
  const available = days.filter((d) => d.working && !d.onLeave);
  const target = Math.min(requiredDays, available.length);
  const planned = available.filter((d) => d.planned === required).length;
  let actual = 0;
  const out = days.map((d) => {
    const units = d.onLeave ? 0 : actualUnits(required, d.actualStatus, d.actualMode);
    actual += units;
    let why: string;
    if (d.onLeave) why = 'On leave';
    else if (!d.working && !d.planned && units === 0) why = 'Weekly off or holiday';
    else {
      const happened = actualWords(d.actualStatus, d.actualMode);
      why = d.planned
        ? `Planned ${placeWords[d.planned]}, ${happened}`
        : `Nothing planned, ${happened}`;
    }
    return { date: d.date, planned: d.planned, units: units / 100, why };
  });
  const actualDays = actual / 100;
  return { target, planned, actual: actualDays, met: actualDays >= target, days: out };
}

export type TodayStatus =
  'office' | 'wfh' | 'client_site' | 'leave' | 'off' | 'absent' | 'not_checked_in';

/** M2: where someone is today, from attendance first, then leave and the calendar. */
export function todayStatus(input: {
  working: boolean;
  leave: 'full' | 'first' | 'second' | null;
  status: AttendanceStatus | null;
  mode: WorkMode | null;
}): TodayStatus {
  const { status, mode } = input;
  if (status === 'present' || (status === 'half_day' && (mode === 'office' || mode === null))) {
    return 'office';
  }
  if (status === 'wfh' || (status === 'half_day' && mode === 'wfh')) return 'wfh';
  if (status === 'client_site' || (status === 'half_day' && mode === 'client_site')) {
    return 'client_site';
  }
  if (input.leave === 'full' || status === 'leave') return 'leave';
  if (!input.working) return 'off';
  if (status === 'absent') return 'absent';
  return 'not_checked_in';
}
