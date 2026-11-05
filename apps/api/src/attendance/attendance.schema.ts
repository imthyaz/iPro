import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { softDeleteColumns, tenantColumns } from '../db/columns.js';
import { engagements } from '../people/people.schema.js';

/**
 * A shift: hours and the working-week pattern. Weekly offs are ISO weekdays (1 = Monday … 7 = Sunday),
 * so a Middle East team's Sun–Thu week has offs [5, 6]. Times are local to the person's location.
 */
export const shifts = pgTable(
  'shift',
  {
    ...tenantColumns(),
    ...softDeleteColumns(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    startTime: time('start_time').notNull(),
    /** Earlier than start for a shift that ends after midnight. */
    endTime: time('end_time').notNull(),
    breakMinutes: integer('break_minutes').notNull().default(60),
    graceMinutes: integer('grace_minutes').notNull().default(15),
    /** Worked time below this is a half-day (spec default: under 4 hours). */
    halfDayMinutes: integer('half_day_minutes').notNull().default(240),
    weeklyOffs: smallint('weekly_offs').array().notNull(),
    /** People with no shift allocation work this shift. Exactly one per tenant. */
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [
    uniqueIndex('shift_code_key').on(t.tenantId, t.code),
    uniqueIndex('shift_one_default_key')
      .on(t.tenantId)
      .where(sql`${t.isDefault} and ${t.deletedAt} is null`),
  ],
);

/**
 * Which shift a person works, dated (decision #46): e.g. Sun–Thu while on a Middle East customer's
 * project. Overrides the tenant's default shift; one allocation in force per engagement per day.
 */
export const shiftAssignments = pgTable(
  'shift_assignment',
  {
    ...tenantColumns(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    shiftId: uuid('shift_id')
      .notNull()
      .references(() => shifts.id),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    /**
     * When this person starts and ends the day, if different from the shift's times (e.g. 11:00–20:00
     * to overlap a customer's hours). Both or neither; null = the shift's own times.
     */
    startTime: time('start_time'),
    endTime: time('end_time'),
    /** Why, e.g. the customer project. Projects themselves arrive in a later phase. */
    reason: text('reason').notNull(),
    /** The customer's or the company's holidays for this period (decision #48); null = the location's. */
    holidayCalendarId: uuid('holiday_calendar_id').references(() => holidayCalendars.id),
  },
  (t) => [index('shift_assignment_engagement_idx').on(t.engagementId)],
);

/** A holiday calendar: the company's (per location) or a customer's (decisions #48, #66). */
export const holidayCalendars = pgTable(
  'holiday_calendar',
  {
    ...tenantColumns(),
    ...softDeleteColumns(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['company', 'customer'] }).notNull(),
  },
  (t) => [uniqueIndex('holiday_calendar_code_key').on(t.tenantId, t.code)],
);

/**
 * A holiday on a calendar. Optional ones are working days unless taken as leave (slice 7). Removing
 * one is a soft delete, so a calendar's history stays.
 */
export const holidays = pgTable(
  'holiday',
  {
    ...tenantColumns(),
    ...softDeleteColumns(),
    calendarId: uuid('calendar_id')
      .notNull()
      .references(() => holidayCalendars.id),
    date: date('date').notNull(),
    name: text('name').notNull(),
    optional: boolean('optional').notNull().default(false),
  },
  (t) => [
    uniqueIndex('holiday_calendar_date_key')
      .on(t.tenantId, t.calendarId, t.date)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * A biometric device (decision #67). It pushes punches with its key; only the key's SHA-256 is kept.
 * People are matched by employee code, as enrolled on the device.
 */
export const biometricDevices = pgTable(
  'biometric_device',
  {
    ...tenantColumns(),
    ...softDeleteColumns(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    locationId: uuid('location_id').notNull(),
    keyHash: text('key_hash').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('biometric_device_code_key').on(t.tenantId, t.code),
    uniqueIndex('biometric_device_key_hash_key').on(t.keyHash),
  ],
);

/**
 * A raw punch: the input to attendance days. Add-only. Web and phone check-ins carry the mode and the
 * device's location, with how far it was from the expected site (decision #68).
 */
export const punches = pgTable(
  'punch',
  {
    ...tenantColumns(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    personId: uuid('person_id').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    /** The business date in India the punch counts for. */
    day: date('day').notNull(),
    direction: text('direction', { enum: ['in', 'out'] }),
    source: text('source', { enum: ['web', 'mobile', 'biometric'] }).notNull(),
    mode: text('mode', { enum: ['office', 'wfh', 'client_site'] }),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    accuracyMetres: doublePrecision('accuracy_metres'),
    /** The site it was checked against, and how far away it was. */
    siteLocationId: uuid('site_location_id'),
    distanceMetres: integer('distance_metres'),
    outsideGeofence: boolean('outside_geofence'),
    deviceId: uuid('device_id').references(() => biometricDevices.id),
    externalId: text('external_id'),
  },
  (t) => [
    index('punch_engagement_day_idx').on(t.engagementId, t.day),
    uniqueIndex('punch_device_external_key')
      .on(t.tenantId, t.deviceId, t.externalId)
      .where(sql`${t.deviceId} is not null`),
  ],
);

/**
 * One person's day, built from punches, the shift, holidays and leave (the attendance build). Rebuilt
 * as punches arrive; a regularised day (slice 6c) keeps its corrected status.
 */
export const attendanceDays = pgTable(
  'attendance_day',
  {
    ...tenantColumns(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    personId: uuid('person_id').notNull(),
    day: date('day').notNull(),
    status: text('status', {
      enum: [
        'present',
        'absent',
        'half_day',
        'leave',
        'holiday',
        'weekly_off',
        'wfh',
        'client_site',
      ],
    }).notNull(),
    firstIn: timestamp('first_in', { withTimezone: true }),
    lastOut: timestamp('last_out', { withTimezone: true }),
    workedMinutes: integer('worked_minutes'),
    mode: text('mode', { enum: ['office', 'wfh', 'client_site'] }),
    flags: text('flags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    regularised: boolean('regularised').notNull().default(false),
    builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('attendance_day_key').on(t.tenantId, t.engagementId, t.day)],
);
