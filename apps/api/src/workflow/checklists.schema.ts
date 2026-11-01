import {
  boolean,
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
import { appUsers, roleEnum } from '../identity/identity.schema.js';
import { documents } from '../people/documents.schema.js';
import { engagements, persons } from '../people/people.schema.js';

/**
 * A checklist template (screen A3): tasks with owners and due offsets. Versioned like workflow
 * definitions — saving creates a new version, and runs keep the version they started from.
 */
export const checklistTemplates = pgTable(
  'checklist_template',
  {
    ...tenantColumns(),
    key: text('key').notNull(),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    stage: text('stage', { enum: ['onboarding', 'exit', 'transfer', 'access'] }).notNull(),
    appliesTo: jsonb('applies_to').$type<Record<string, unknown>>().notNull(),
    /** The template's tasks (title, owner, due offset, mandatory, requires document). */
    tasks: jsonb('tasks').$type<Record<string, unknown>[]>().notNull(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('checklist_template_version_key').on(t.tenantId, t.key, t.version)],
);

/** One checklist for one engagement, e.g. Asha's onboarding. */
export const checklistRuns = pgTable(
  'checklist_run',
  {
    ...tenantColumns(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => checklistTemplates.id),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    anchorDate: date('anchor_date').notNull(),
    status: text('status', { enum: ['open', 'complete', 'cancelled'] }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
  },
  (t) => [index('checklist_run_person_idx').on(t.personId)],
);

/** A task of a run (the spec's TaskInstance). Owner resolved when the run starts. */
export const checklistTasks = pgTable(
  'checklist_task',
  {
    ...tenantColumns(),
    runId: uuid('run_id')
      .notNull()
      .references(() => checklistRuns.id),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    /** The template's owner rule, kept for display ("Manager", "IT: Ravi"). */
    ownerLabel: text('owner_label').notNull(),
    /** employee: whoever the run is about (works before they can sign in); else resolved below. */
    ownerKind: text('owner_kind', { enum: ['employee', 'manager', 'role', 'user'] }).notNull(),
    assigneeUserId: uuid('assignee_user_id').references(() => appUsers.id),
    assigneeRole: roleEnum('assignee_role'),
    dueOn: date('due_on').notNull(),
    mandatory: boolean('mandatory').notNull(),
    requiresDocument: boolean('requires_document').notNull(),
    status: text('status', { enum: ['open', 'done', 'waived'] })
      .notNull()
      .default('open'),
    doneBy: uuid('done_by').references(() => appUsers.id),
    doneAt: timestamp('done_at', { withTimezone: true }),
    evidenceDocumentId: uuid('evidence_document_id').references(() => documents.id),
    note: text('note'),
    waiveReason: text('waive_reason'),
    /** Last business date an overdue reminder went out (one a day, spec: daily while overdue). */
    lastRemindedOn: date('last_reminded_on'),
  },
  (t) => [
    index('checklist_task_run_idx').on(t.runId),
    index('checklist_task_assignee_idx').on(t.assigneeUserId),
  ],
);
