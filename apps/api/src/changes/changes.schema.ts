import { date, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenantColumns } from '../db/columns.js';
import { persons } from '../people/people.schema.js';
import { workflowInstances } from '../workflow/workflow.schema.js';

export const scheduledChangeKinds = ['conversion'] as const;
export const scheduledChangeStatuses = ['pending', 'applied', 'failed', 'cancelled'] as const;

/**
 * An approved change that can't apply before its date (a conversion opens a new engagement, so it
 * can't be pre-dated like an assignment row). A daily job applies it on the day (decision #64).
 * Pay inside the payload stays encrypted.
 */
export const scheduledChanges = pgTable(
  'scheduled_change',
  {
    ...tenantColumns(),
    kind: text('kind', { enum: scheduledChangeKinds }).notNull(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    requestId: uuid('request_id').references(() => workflowInstances.id),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    runOn: date('run_on').notNull(),
    status: text('status', { enum: scheduledChangeStatuses }).notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    /** Why it couldn't apply (no personal data: ids and rule messages only). */
    failure: text('failure'),
  },
  (t) => [index('scheduled_change_due_idx').on(t.tenantId, t.status, t.runOn)],
);
