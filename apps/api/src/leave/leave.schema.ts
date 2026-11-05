import type { AppliesTo } from '@ipro/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
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
 * A leave type (A2 Policies; decision #71): configuration, edited by admins and HR head. Day
 * quantities are integer hundredths of a day (decision #72). Types are never deleted; they are
 * made inactive.
 */
export const leaveTypes = pgTable(
  'leave_type',
  {
    ...tenantColumns(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['accrued', 'granted', 'per_request', 'unlimited'] }).notNull(),
    paid: boolean('paid').notNull(),
    perYear: integer('per_year'),
    creditOn: text('credit_on', { enum: ['month_start', 'month_end'] })
      .notNull()
      .default('month_end'),
    accruesAfterConfirmation: boolean('accrues_after_confirmation').notNull().default(false),
    availableOnProbation: boolean('available_on_probation').notNull().default(true),
    maxBalance: integer('max_balance'),
    carryForwardCap: integer('carry_forward_cap'),
    encashable: boolean('encashable').notNull().default(false),
    documentAfterDays: smallint('document_after_days'),
    allowNegative: boolean('allow_negative').notNull().default(false),
    maxPerRequest: integer('max_per_request'),
    countsCalendarDays: boolean('counts_calendar_days').notNull().default(false),
    expiresAfterDays: smallint('expires_after_days'),
    appliesTo: jsonb('applies_to').$type<AppliesTo>().notNull().default({}),
    active: boolean('active').notNull().default(true),
    sortOrder: smallint('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('leave_type_code_key').on(t.tenantId, t.code)],
);

/**
 * The leave ledger (decision #72): every change to a balance is one add-only entry, so each
 * balance shows how it was reached. A year's balance is the sum of that year's entries; year end
 * writes the lapse in the old year and the carry-forward in the new one.
 */
export const leaveLedger = pgTable(
  'leave_ledger_entry',
  {
    ...tenantColumns(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    personId: uuid('person_id').notNull(),
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveTypes.id),
    year: smallint('year').notNull(),
    entryDate: date('entry_date').notNull(),
    kind: text('kind', {
      enum: [
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
      ],
    }).notNull(),
    /** Signed hundredths of a day. */
    amount: integer('amount').notNull(),
    /** What a scheduled entry is for: YYYY-MM for an accrual, YYYY for year end. */
    period: text('period'),
    note: text('note'),
    sourceTable: text('source_table'),
    sourceId: uuid('source_id'),
  },
  (t) => [
    index('leave_ledger_balance_idx').on(t.engagementId, t.leaveTypeId, t.year),
    // A scheduled entry is written once, so a job that runs twice changes nothing.
    uniqueIndex('leave_ledger_scheduled_key')
      .on(t.tenantId, t.engagementId, t.leaveTypeId, t.kind, t.period)
      .where(sql`${t.kind} in ('accrual', 'carry_forward', 'lapse')`),
  ],
);

/**
 * A leave request (spec workflow 4; decision #74). Its days are in leave_request_day, each with the
 * type it is taken as (the asked type, or loss of pay for a shortfall). Approval debits the
 * balance; cancelling or revoking gives the days back.
 */
export const leaveRequests = pgTable(
  'leave_request',
  {
    ...tenantColumns(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    personId: uuid('person_id').notNull(),
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveTypes.id),
    fromDate: date('from_date').notNull(),
    toDate: date('to_date').notNull(),
    startHalf: text('start_half', { enum: ['full', 'second'] }).notNull(),
    endHalf: text('end_half', { enum: ['full', 'first'] }).notNull(),
    /** Hundredths of a day, all days; and how many of them are loss of pay. */
    days: integer('days').notNull(),
    lopDays: integer('lop_days').notNull().default(0),
    reason: text('reason'),
    status: text('status', {
      enum: ['applied', 'returned', 'approved', 'cancelled', 'revoked', 'withdrawn'],
    }).notNull(),
    /** Applied on or after the first day (spec: counts as unplanned for absenteeism). */
    unplanned: boolean('unplanned').notNull().default(false),
    needsCertificate: boolean('needs_certificate').notNull().default(false),
    certificateDocumentId: uuid('certificate_document_id'),
    workflowInstanceId: uuid('workflow_instance_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    revokedFrom: date('revoked_from'),
    revokeReason: text('revoke_reason'),
  },
  (t) => [index('leave_request_person_idx').on(t.personId, t.fromDate)],
);

/** One day (or half day) of a request, as the type it is taken as. Cancelled days stay, marked. */
export const leaveRequestDays = pgTable(
  'leave_request_day',
  {
    ...tenantColumns(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => leaveRequests.id),
    engagementId: uuid('engagement_id').notNull(),
    personId: uuid('person_id').notNull(),
    day: date('day').notNull(),
    half: text('half', { enum: ['full', 'first', 'second'] }).notNull(),
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveTypes.id),
    amount: smallint('amount').notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => [
    index('leave_request_day_engagement_idx').on(t.engagementId, t.day),
    index('leave_request_day_request_idx').on(t.requestId),
  ],
);

/**
 * A comp-off request (decisions #73, #76): the employee asks for a weekly off or holiday they
 * worked, their manager approves, and the day (or half day) is granted, usable until `valid_until`.
 * The daily job expires what is left of it after that.
 */
export const compOffRequests = pgTable(
  'comp_off_request',
  {
    ...tenantColumns(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    personId: uuid('person_id').notNull(),
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveTypes.id),
    workedOn: date('worked_on').notNull(),
    /** "Weekly off" or the holiday's name, as it was when asked. */
    dayKind: text('day_kind').notNull(),
    /** Hundredths of a day: 100 or 50. */
    amount: smallint('amount').notNull(),
    reason: text('reason'),
    status: text('status', {
      enum: ['applied', 'returned', 'approved', 'withdrawn'],
    }).notNull(),
    workflowInstanceId: uuid('workflow_instance_id'),
    grantedOn: date('granted_on'),
    validUntil: date('valid_until'),
    /** Set by the expiry job: when it ran and what was left (hundredths, 0 when all was used). */
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    expiredAmount: smallint('expired_amount'),
  },
  (t) => [
    // One live request a day; a withdrawn one can be asked again.
    uniqueIndex('comp_off_request_day_key')
      .on(t.tenantId, t.engagementId, t.workedOn)
      .where(sql`${t.status} in ('applied', 'returned', 'approved')`),
    index('comp_off_request_expiry_idx')
      .on(t.validUntil)
      .where(sql`${t.status} = 'approved' and ${t.expiredAt} is null`),
  ],
);
