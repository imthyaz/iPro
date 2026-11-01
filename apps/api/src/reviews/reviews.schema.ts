import { sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenantColumns } from '../db/columns.js';
import { appUsers } from '../identity/identity.schema.js';
import { engagements, persons } from '../people/people.schema.js';
import { workflowInstances } from '../workflow/workflow.schema.js';

// Kept in step with @ipro/shared (drizzle-kit can't import it); a unit test checks they match.
export const reviewKinds = ['probation', 'internship'] as const;
export const reviewStatuses = ['due', 'submitted', 'decided', 'cancelled'] as const;
export const probationOutcomes = ['confirm', 'extend', 'terminate'] as const;

/**
 * A probation review (spec workflow 3; decision #60): opened 30 days before the end date, filled in by
 * the manager, decided by HR (terminations by HR head). Interns' assessments use the same table (5c).
 */
export const reviews = pgTable(
  'review',
  {
    ...tenantColumns(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    kind: text('kind', { enum: reviewKinds }).notNull(),
    status: text('status', { enum: reviewStatuses }).notNull(),
    /** The end date being reviewed (probation end, or the internship's end). */
    dueOn: date('due_on').notNull(),
    /** The manager when the review opened; null means HR fills it in (no manager with a sign-in). */
    reviewerUserId: uuid('reviewer_user_id').references(() => appUsers.id),
    recommendation: text('recommendation', { enum: probationOutcomes }),
    ratings: jsonb('ratings').$type<Record<string, number>>().notNull().default({}),
    strengths: text('strengths'),
    improvements: text('improvements'),
    comments: text('comments'),
    newEndDate: date('new_end_date'),
    lastWorkingDate: date('last_working_date'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    submittedBy: uuid('submitted_by').references(() => appUsers.id),
    requestId: uuid('request_id').references(() => workflowInstances.id),
    decision: text('decision', { enum: probationOutcomes }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** Days-before-due reminders already sent (e.g. [14, 7]), so the daily sweep sends each once. */
    remindedFor: jsonb('reminded_for').$type<number[]>().notNull().default([]),
    lastEscalatedOn: date('last_escalated_on'),
    escalationCount: integer('escalation_count').notNull().default(0),
  },
  (t) => [
    index('review_engagement_idx').on(t.engagementId),
    index('review_status_idx').on(t.tenantId, t.status),
    // One open review per engagement and kind at a time.
    uniqueIndex('review_open_key')
      .on(t.tenantId, t.engagementId, t.kind)
      .where(sql`${t.status} in ('due', 'submitted')`),
  ],
);
