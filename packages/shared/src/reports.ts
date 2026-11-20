import { z } from 'zod';

/** H12 Phase 1 reports (slice 13a; decision #93). All are aggregates for HR and CXO. */
export const reportRangeSchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((v) => v.from <= v.to, { message: 'The range ends before it starts', path: ['to'] });
export const reportDateSchema = z.object({ asOf: z.iso.date() });
export const reportYearSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
});

export interface CountRow {
  name: string;
  count: number;
}

export interface HeadcountReport {
  asOf: string;
  total: number;
  byDepartment: CountRow[];
  byLocation: CountRow[];
  byType: CountRow[];
}

export interface MovementReport {
  from: string;
  to: string;
  joiners: number;
  leavers: number;
  months: { month: string; joiners: number; leavers: number }[];
  joinersByDepartment: CountRow[];
  leaversByDepartment: CountRow[];
  /** The people behind each figure (spec: every number opens the list behind it). */
  joinerList: { personId: string; name: string; date: string; department: string | null }[];
  leaverList: { personId: string; name: string; date: string; department: string | null }[];
}

export interface AttritionReport {
  from: string;
  to: string;
  leavers: number;
  voluntary: number;
  involuntary: number;
  /** Exits recorded without how they happened (e.g. migrated history). */
  unknown: number;
  monthEnds: { date: string; headcount: number }[];
  averageHeadcount: number;
  /** Leavers ÷ average month-end headcount, % for the period, and annualised (decision #93). */
  rate: number;
  annualised: number;
}

export interface AbsenteeismRow {
  name: string;
  workingDays: number;
  unplannedLeaveDays: number;
  absentDays: number;
  rate: number;
}

export interface AbsenteeismReport extends Omit<AbsenteeismRow, 'name'> {
  from: string;
  to: string;
  byDepartment: AbsenteeismRow[];
}

export interface LeaveLiabilityReport {
  year: number;
  byType: { code: string; name: string; days: number; encashable: boolean }[];
  byDepartment: { name: string; days: Record<string, number> }[];
  /**
   * Estimated value of encashable leave (days × annual CTC ÷ 365), in paise, for those allowed to
   * see pay; null otherwise. Each pay read is audited.
   */
  value: { paise: string; people: number; byType: { code: string; paise: string }[] } | null;
}

export interface HybridComplianceReport {
  from: string;
  to: string;
  weeks: { weekStart: string; people: number; met: number; approvedBelow: number; rate: number }[];
  /** Weeks met (approved exceptions count as met) ÷ person-weeks, %. */
  rate: number;
}

export interface SeatOccupancyReport {
  from: string;
  to: string;
  byLocation: {
    location: string;
    seats: number;
    workingDays: number;
    bookedSeatDays: number;
    /** Booked seat-days ÷ (seats × working days), %. */
    average: number;
    peak: number;
    peakDate: string | null;
  }[];
}
