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
