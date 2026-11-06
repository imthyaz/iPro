import type { AppliesTo } from '@ipro/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenantColumns } from '../db/columns.js';
import { locations } from '../org/org.schema.js';
import { engagements } from '../people/people.schema.js';

const MODES = ['office', 'wfh', 'client_site'] as const;

/**
 * A work policy (spec data model: WorkPolicy; decision #78): configuration, never constants in
 * code. The first active policy, by priority, that matches a person applies to them.
 */
export const workPolicies = pgTable(
  'work_policy',
  {
    ...tenantColumns(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    requiredMode: text('required_mode', { enum: ['office', 'client_site'] }).notNull(),
    requiredDays: smallint('required_days').notNull(),
    anchorDayRequired: boolean('anchor_day_required').notNull().default(false),
    allowedModes: text('allowed_modes', { enum: MODES }).array().notNull(),
    appliesTo: jsonb('applies_to').$type<AppliesTo>().notNull().default({}),
    locationTypes: text('location_types', { enum: ['office', 'client_site', 'remote'] })
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    priority: smallint('priority').notNull(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('work_policy_code_key').on(t.tenantId, t.code)],
);

/** A bookable seat at an office (spec data model: Seat). Seats are made inactive, not deleted. */
export const seats = pgTable(
  'seat',
  {
    ...tenantColumns(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    label: text('label').notNull(),
    zone: text('zone'),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('seat_label_key').on(t.tenantId, t.locationId, t.label)],
);

/** A team's anchor day (decision #78): the manager's direct reports come in on this weekday. */
export const teamAnchorDays = pgTable(
  'team_anchor_day',
  {
    ...tenantColumns(),
    managerEngagementId: uuid('manager_engagement_id')
      .notNull()
      .references(() => engagements.id),
    /** ISO weekday, 1 = Monday; null clears it. */
    weekday: smallint('weekday'),
  },
  (t) => [uniqueIndex('team_anchor_day_manager_key').on(t.tenantId, t.managerEngagementId)],
);

/**
 * A week below policy, waiting for or decided by the manager (spec workflow 6). Its bookings are
 * pending until it is approved.
 */
export const hybridExceptions = pgTable(
  'hybrid_exception',
  {
    ...tenantColumns(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    personId: uuid('person_id').notNull(),
    weekStart: date('week_start').notNull(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => workPolicies.id),
    reasons: jsonb('reasons').$type<string[]>().notNull(),
    note: text('note'),
    status: text('status', {
      enum: ['pending', 'approved', 'returned', 'withdrawn'],
    }).notNull(),
    workflowInstanceId: uuid('workflow_instance_id'),
  },
  (t) => [index('hybrid_exception_week_idx').on(t.engagementId, t.weekStart)],
);

/**
 * One day planned (spec data model: WorkBooking). A change cancels the day's row and adds a new
 * one, so the plan's history stays. A seat is held by one live booking a day.
 */
export const workBookings = pgTable(
  'work_booking',
  {
    ...tenantColumns(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    personId: uuid('person_id').notNull(),
    date: date('date').notNull(),
    weekStart: date('week_start').notNull(),
    mode: text('mode', { enum: MODES }).notNull(),
    locationId: uuid('location_id').references(() => locations.id),
    seatId: uuid('seat_id').references(() => seats.id),
    status: text('status', {
      enum: ['confirmed', 'pending', 'rejected', 'cancelled'],
    }).notNull(),
    exceptionId: uuid('exception_id').references(() => hybridExceptions.id),
  },
  (t) => [
    uniqueIndex('work_booking_day_key')
      .on(t.tenantId, t.engagementId, t.date)
      .where(sql`${t.status} <> 'cancelled'`),
    uniqueIndex('work_booking_seat_key')
      .on(t.tenantId, t.seatId, t.date)
      .where(sql`${t.seatId} is not null and ${t.status} in ('confirmed', 'pending')`),
    index('work_booking_location_idx').on(t.locationId, t.date),
    index('work_booking_week_idx').on(t.engagementId, t.weekStart),
  ],
);
