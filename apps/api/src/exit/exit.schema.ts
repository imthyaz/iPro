import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenantColumns } from '../db/columns.js';
import { engagements } from '../people/people.schema.js';

/**
 * One exit (spec workflow 7; decision #80): a resignation or a termination, from submission to
 * exit or withdrawal. The engagement carries the agreed last working day and status; this row
 * carries how it was reached. Kept with its outcome, never deleted.
 */
export const exitCases = pgTable(
  'exit_case',
  {
    ...tenantColumns(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    personId: uuid('person_id').notNull(),
    kind: text('kind', { enum: ['resignation', 'termination'] }).notNull(),
    status: text('status', {
      enum: ['submitted', 'serving_notice', 'clearance', 'exited', 'withdrawn'],
    }).notNull(),
    resignationDate: date('resignation_date').notNull(),
    /** Sensitive: shown to the person, their manager and HR; never on a manager's timeline. */
    reason: text('reason'),
    reasonNote: text('reason_note'),
    noticeDays: smallint('notice_days').notNull(),
    noticeLastDay: date('notice_last_day').notNull(),
    proposedLastDay: date('proposed_last_day'),
    lastWorkingDate: date('last_working_date'),
    earlyRelease: text('early_release', { enum: ['buyout', 'waiver'] }),
    buyoutDays: smallint('buyout_days'),
    /** The manager's retention conversation (decision #80): HR and that manager only. */
    retentionNote: text('retention_note'),
    managerAcceptedBy: uuid('manager_accepted_by'),
    managerAcceptedAt: timestamp('manager_accepted_at', { withTimezone: true }),
    hrAcceptedBy: uuid('hr_accepted_by'),
    hrAcceptedAt: timestamp('hr_accepted_at', { withTimezone: true }),
    hrNote: text('hr_note'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    workflowInstanceId: uuid('workflow_instance_id'),
    withdrawalInstanceId: uuid('withdrawal_instance_id'),
    withdrawReason: text('withdraw_reason'),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    terminationReason: text('termination_reason'),
    /** Every exit checklist task done (spec: Serving notice → Clearance). */
    clearanceDoneAt: timestamp('clearance_done_at', { withTimezone: true }),
    /** The exit interview (decision #81): HR-only answers, or declined; the rehire flag. */
    interviewRecordedAt: timestamp('interview_recorded_at', { withTimezone: true }),
    interviewRecordedBy: uuid('interview_recorded_by'),
    interviewDeclined: boolean('interview_declined'),
    interviewAnswers: jsonb('interview_answers').$type<Record<string, string>>(),
    interviewNote: text('interview_note'),
    rehireEligible: boolean('rehire_eligible'),
    /** Access ended at the end of the last day (decision #82): Entra and iPro, or iPro and an IT task. */
    accessDisabledAt: timestamp('access_disabled_at', { withTimezone: true }),
    accessMethod: text('access_method', { enum: ['entra', 'it_task'] }),
    exitedAt: timestamp('exited_at', { withTimezone: true }),
    exitedBy: uuid('exited_by'),
  },
  (t) => [
    // One open exit an engagement.
    uniqueIndex('exit_case_open_key')
      .on(t.tenantId, t.engagementId)
      .where(sql`${t.status} in ('submitted', 'serving_notice', 'clearance')`),
    index('exit_case_status_idx').on(t.status),
  ],
);
