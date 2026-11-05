import { z } from 'zod';
import { appliesToSchema } from './checklists.js';

/**
 * Leave (slice 7; decisions #71, #72). Quantities are kept as integer hundredths of a day, like
 * money in paise, so 1.25 days a month accrues exactly; the API shows days.
 */
export const HUNDREDTHS = 100;
export const toDays = (hundredths: number) => hundredths / HUNDREDTHS;
export const toHundredths = (days: number) => Math.round(days * HUNDREDTHS);

/**
 * How a type is earned: accrued monthly; granted for a reason (comp-off); a fixed entitlement per
 * request (maternity, bereavement); or unlimited and unpaid (loss of pay).
 */
export const leaveKindSchema = z.enum(['accrued', 'granted', 'per_request', 'unlimited']);
export type LeaveKind = z.infer<typeof leaveKindSchema>;

const days = z.number().min(0).max(1000);

/** A leave type (A2 Policies): configuration, never constants in code. */
export const leaveTypeInputSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(12)
    .regex(/^[A-Z0-9_]+$/),
  name: z.string().trim().min(1).max(80),
  kind: leaveKindSchema,
  paid: z.boolean(),
  /** Days a year, credited monthly (accrued kind only). */
  daysPerYear: days.nullable(),
  /**
   * When a month's credit is given (decision #73): at the start of the month, in advance (casual,
   * sick), or at its end, for the month just worked (earned).
   */
  creditOn: z.enum(['month_start', 'month_end']),
  /** Accrual starts on the confirmation date (e.g. earned leave). */
  accruesAfterConfirmation: z.boolean(),
  /** Usable during probation. */
  availableOnProbation: z.boolean(),
  /** Accrual stops at this balance; null means no cap. */
  maxBalance: days.nullable(),
  /** Days carried into the next year; 0 lapses everything, null carries everything. */
  carryForwardCap: days.nullable(),
  encashable: z.boolean(),
  /** A document is needed for more than this many consecutive days (e.g. medical certificate). */
  documentAfterDays: z.number().int().min(0).max(365).nullable(),
  allowNegative: z.boolean(),
  /** Weekly offs and holidays inside the leave count too (e.g. maternity: 26 weeks). */
  countsCalendarDays: z.boolean(),
  /** Per-request entitlement (per_request kind), e.g. 182 days of maternity leave. */
  maxDaysPerRequest: days.nullable(),
  /** Granted leave lapses this many days after it is granted (comp-off). */
  expiresAfterDays: z.number().int().min(1).max(3650).nullable(),
  appliesTo: appliesToSchema,
  active: z.boolean(),
});
export type LeaveTypeInput = z.infer<typeof leaveTypeInputSchema>;

export interface LeaveTypeView extends LeaveTypeInput {
  id: string;
  sortOrder: number;
}

export const ledgerKindSchema = z.enum([
  'opening',
  'accrual',
  'carry_forward',
  'lapse',
  'grant',
  'expiry',
  'taken',
  'restored',
  'encashed',
  'adjustment',
]);
export type LedgerKind = z.infer<typeof ledgerKindSchema>;

export interface LedgerEntryView {
  id: string;
  date: string;
  kind: LedgerKind;
  days: number;
  /** Why: e.g. "January accrual, 31 of 31 days", "Imported balance", HR's reason. */
  note: string | null;
}

/** One type's balance for a year, with how it was reached (every number has its "why"). */
export interface LeaveBalanceView {
  leaveType: Pick<LeaveTypeView, 'id' | 'code' | 'name' | 'kind' | 'paid'>;
  year: number;
  opening: number;
  accrued: number;
  granted: number;
  taken: number;
  lapsed: number;
  encashed: number;
  adjusted: number;
  balance: number;
  entries: LedgerEntryView[];
  /** Granted leave still held and when it runs out, soonest first (comp-off; empty otherwise). */
  expiring: { days: number; on: string }[];
}

export const leaveYearQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
});

/** POST /api/people/:id/leave/adjustments (H9): HR changes a balance, with a reason. */
export const leaveAdjustmentSchema = z.object({
  leaveTypeId: z.uuid(),
  /** Signed, in half days. */
  days: z
    .number()
    .min(-366)
    .max(366)
    .refine((d) => d !== 0 && Number.isInteger(d * 2), 'Use whole or half days'),
  reason: z.string().trim().min(3).max(500),
});
export type LeaveAdjustmentInput = z.infer<typeof leaveAdjustmentSchema>;

/**
 * POST /api/leave/balances/import (migration): a CSV of employee_code, leave_type, balance as of a
 * date. Checked first (commit false), then applied; applying again changes nothing.
 */
export const leaveImportSchema = z.object({
  csv: z.string().min(1).max(2_000_000),
  asOf: z.iso.date(),
  commit: z.boolean(),
});
export type LeaveImportInput = z.infer<typeof leaveImportSchema>;

export interface LeaveImportResult {
  committed: boolean;
  rows: number;
  /** Rows whose balance changes, and by how much. */
  changes: { line: number; employeeCode: string; leaveType: string; from: number; to: number }[];
  errors: { line: number; message: string }[];
}

/** Spec workflow 4 as built (decision #74). */
export const leaveRequestStatusSchema = z.enum([
  'applied',
  'returned',
  'approved',
  'cancelled',
  'revoked',
  'withdrawn',
]);
export type LeaveRequestStatus = z.infer<typeof leaveRequestStatusSchema>;

/** E4: the request. The first day may start in the afternoon; the last may end at midday. */
export const leaveApplySchema = z
  .object({
    leaveTypeId: z.uuid(),
    from: z.iso.date(),
    to: z.iso.date(),
    startHalf: z.enum(['full', 'second']).default('full'),
    endHalf: z.enum(['full', 'first']).default('full'),
    reason: z.string().trim().max(500).optional(),
    /** Take days beyond the balance as loss of pay (decision #74), after the form offered it. */
    lopForShortfall: z.boolean().default(false),
  })
  .refine((v) => v.from <= v.to, { message: 'The leave ends before it starts', path: ['to'] });
export type LeaveApplyInput = z.input<typeof leaveApplySchema>;

/** What a request would be, shown on the form before sending (balance after, warnings). */
export interface LeavePreview {
  days: number;
  /** Days taken from the asked type and as loss of pay. */
  fromType: number;
  lop: number;
  balanceBefore: number | null;
  balanceAfter: number | null;
  /** Days beyond the balance (offer loss of pay) when the type can't go negative. */
  shortfall: number;
  needsSecondApproval: boolean;
  unplanned: boolean;
  /** A certificate is needed (e.g. more than 2 consecutive sick days). */
  needsCertificate: boolean;
  /** Reasons it can't be sent, in plain words. */
  problems: string[];
}

export interface LeaveRequestView {
  id: string;
  personId: string;
  leaveType: { id: string; code: string; name: string };
  from: string;
  to: string;
  startHalf: 'full' | 'second';
  endHalf: 'full' | 'first';
  days: number;
  lop: number;
  reason: string | null;
  status: LeaveRequestStatus;
  unplanned: boolean;
  certificateAttached: boolean;
  needsCertificate: boolean;
  requestId: string | null;
  /** Revoked by HR from this day. */
  revokedFrom: string | null;
  canCancel: boolean;
  createdAt: string;
}

/** POST /api/leave/requests/:id/revoke (HR, after the leave started): days from a date are given back. */
export const leaveRevokeSchema = z.object({
  from: z.iso.date(),
  reason: z.string().trim().min(3).max(500),
});
export type LeaveRevokeInput = z.infer<typeof leaveRevokeSchema>;

/**
 * POST /api/leave/comp-off (decision #76): the employee asks for comp-off for a weekly off or holiday
 * they worked; their manager approves and it is credited, usable for the type's expiry days.
 */
export const compOffRequestSchema = z.object({
  workedOn: z.iso.date(),
  days: z.number().refine((n) => n === 1 || n === 0.5, 'Choose a full day or half a day'),
  reason: z.string().trim().max(500).optional(),
});
export type CompOffRequestInput = z.infer<typeof compOffRequestSchema>;

export const compOffStatusSchema = z.enum(['applied', 'returned', 'approved', 'withdrawn']);
export type CompOffStatus = z.infer<typeof compOffStatusSchema>;

export interface CompOffRequestView {
  id: string;
  workedOn: string;
  /** "Weekly off" or the holiday's name. */
  dayKind: string;
  days: number;
  reason: string | null;
  status: CompOffStatus;
  grantedOn: string | null;
  /** The last day it can be used; null until granted, or when the type never expires. */
  validUntil: string | null;
  /** What was left of it when it expired. */
  expiredDays: number | null;
  requestId: string | null;
  canCancel: boolean;
  createdAt: string;
}
