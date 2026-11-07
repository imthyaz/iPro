import { z } from 'zod';

/**
 * Exit (slice 9; spec workflow 7; decision #80). A resignation is accepted by the manager (after a
 * retention conversation) and HR (who fixes the last working day); an earlier last day than the
 * notice allows needs a buyout or waiver approved by HR head. HR head can also start a termination.
 */
export const exitReasonSchema = z.enum([
  'better_opportunity',
  'higher_studies',
  'relocation',
  'compensation',
  'role_or_growth',
  'manager_or_team',
  'health',
  'personal',
  'other',
]);
export type ExitReason = z.infer<typeof exitReasonSchema>;

export const exitReasonWords: Record<ExitReason, string> = {
  better_opportunity: 'A better opportunity',
  higher_studies: 'Higher studies',
  relocation: 'Relocation',
  compensation: 'Pay',
  role_or_growth: 'Role or growth',
  manager_or_team: 'Manager or team',
  health: 'Health',
  personal: 'Personal reasons',
  other: 'Other',
};

/** E10: the employee resigns with a reason and the last day they propose. */
export const resignationSchema = z.object({
  reason: exitReasonSchema,
  note: z.string().trim().max(1000).optional(),
  proposedLastDay: z.iso.date(),
});
export type ResignationInput = z.infer<typeof resignationSchema>;

/** The manager accepts after the retention conversation (decision #80: a note is required). */
export const managerAcceptSchema = z.object({
  retentionNote: z.string().trim().min(3).max(2000),
});

/** HR accepts and fixes the last working day; earlier than the notice needs a buyout or waiver. */
export const hrAcceptSchema = z.object({
  lastWorkingDate: z.iso.date(),
  earlyRelease: z.enum(['buyout', 'waiver']).nullable().default(null),
  note: z.string().trim().max(1000).optional(),
});
export type HrAcceptInput = z.input<typeof hrAcceptSchema>;

/** The employee withdraws; once accepted, the manager and HR approve it. */
export const exitWithdrawSchema = z.object({ reason: z.string().trim().min(3).max(1000) });

/** HR head ends employment (spec workflow 7: termination letter, the same checklist). */
export const terminationSchema = z.object({
  lastWorkingDate: z.iso.date(),
  reason: z.string().trim().min(3).max(2000),
});
export type TerminationInput = z.infer<typeof terminationSchema>;

export const exitStatusSchema = z.enum([
  'submitted',
  'serving_notice',
  'clearance',
  'exited',
  'withdrawn',
]);
export type ExitStatus = z.infer<typeof exitStatusSchema>;

export interface ExitCaseView {
  id: string;
  personId: string;
  name: string;
  employeeCode: string;
  kind: 'resignation' | 'termination';
  status: ExitStatus;
  resignationDate: string;
  /** Shown to the person, their manager and HR; never on the timeline for managers. */
  reason: ExitReason | null;
  reasonNote: string | null;
  noticeDays: number;
  noticeLastDay: string;
  proposedLastDay: string | null;
  lastWorkingDate: string | null;
  earlyRelease: 'buyout' | 'waiver' | null;
  /** Notice days bought out (settled at full and final). */
  buyoutDays: number | null;
  /** The manager's retention note: HR and the manager who wrote it only. */
  retentionNote: string | null;
  /** Who it waits for now. */
  waitingFor: 'manager' | 'hr' | 'hr_head' | null;
  requestId: string | null;
  /** A withdrawal asked for after acceptance, waiting for the manager and HR. */
  withdrawal: { status: 'pending' | 'returned'; requestId: string | null } | null;
  checklist: { done: number; total: number } | null;
  /** What the viewer can do now. */
  can: { withdraw: boolean; managerAccept: boolean; hrAccept: boolean };
  createdAt: string;
}

/** E10 before resigning: the notice that would apply if they resigned today. */
export interface MyExitView {
  current: ExitCaseView | null;
  noticeDays: number;
  noticeLastDay: string;
  onProbation: boolean;
}
