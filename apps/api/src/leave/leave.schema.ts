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
