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

/**
 * A workflow as configuration (decision #49): its steps, who approves each, and what happens on approval.
 * Versioned: an item keeps the version it started under; editing creates a new version.
 */
export const workflowDefinitions = pgTable(
  'workflow_definition',
  {
    ...tenantColumns(),
    key: text('key').notNull(),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('workflow_definition_version_key').on(t.tenantId, t.key, t.version)],
);

export const workflowStatuses = ['pending', 'returned', 'approved', 'withdrawn'] as const;

/** One request going through a workflow, e.g. "Asha's phone number change". */
export const workflowInstances = pgTable(
  'workflow_instance',
  {
    ...tenantColumns(),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => workflowDefinitions.id),
    key: text('key').notNull(),
    title: text('title').notNull(),
    /** The person the request is about (authz and timelines). */
    subjectPersonId: uuid('subject_person_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: workflowStatuses }).notNull(),
    /** Index into the definition's steps while pending. */
    currentStep: integer('current_step').notNull().default(0),
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => appUsers.id),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('workflow_instance_submitter_idx').on(t.submittedBy),
    index('workflow_instance_subject_idx').on(t.subjectPersonId),
  ],
);

export const approvalDecisions = ['approved', 'rejected'] as const;

/**
 * One approval step of one item (the spec's Approval). Assigned to a person or to a role in a legal
 * entity; due a number of the approver's working days later, then escalated to their manager.
 */
export const approvals = pgTable(
  'approval',
  {
    ...tenantColumns(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => workflowInstances.id),
    stepIndex: integer('step_index').notNull(),
    stepId: text('step_id').notNull(),
    stepLabel: text('step_label').notNull(),
    assignedUserId: uuid('assigned_user_id').references(() => appUsers.id),
    assignedRole: roleEnum('assigned_role'),
    assignedLegalEntityId: uuid('assigned_legal_entity_id'),
    assignedOn: date('assigned_on').notNull(),
    remindOn: date('remind_on').notNull(),
    dueOn: date('due_on').notNull(),
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    escalatedToUserId: uuid('escalated_to_user_id').references(() => appUsers.id),
    escalatedToRole: roleEnum('escalated_to_role'),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    decision: text('decision', { enum: approvalDecisions }),
    decidedBy: uuid('decided_by').references(() => appUsers.id),
    /** Set when someone decided on behalf of the approver (delegation, decision #23). */
    onBehalfOf: uuid('on_behalf_of').references(() => appUsers.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    comment: text('comment'),
    /** Closed without a decision because the item was withdrawn or returned. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    index('approval_instance_idx').on(t.instanceId),
    index('approval_assigned_user_idx').on(t.assignedUserId),
  ],
);

export const workflowComments = pgTable(
  'workflow_comment',
  {
    ...tenantColumns(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => workflowInstances.id),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => appUsers.id),
    body: text('body').notNull(),
  },
  (t) => [index('workflow_comment_instance_idx').on(t.instanceId)],
);

/**
 * In-app notifications, and the outbox Teams and email deliver from (slice 11). Titles name the
 * request, not personal details beyond what the recipient may already see.
 */
export const notifications = pgTable(
  'notification',
  {
    ...tenantColumns(),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => appUsers.id),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    /** In-app route to open, e.g. /approvals/<id>. */
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [index('notification_recipient_idx').on(t.recipientUserId, t.createdAt)],
);
