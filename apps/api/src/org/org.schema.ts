import {
  bigint,
  char,
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { softDeleteColumns, tenantColumns } from '../db/columns.js';

/** Inclusive start/end (decision #32); null end = open. Overlaps are blocked by exclusion constraints. */
function effectiveColumns() {
  return {
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
  };
}

const money = (name: string) => bigint(name, { mode: 'bigint' });

export const legalEntities = pgTable('legal_entity', {
  ...tenantColumns(),
  ...softDeleteColumns(),
  name: text('name').notNull(),
  country: char('country', { length: 2 }).notNull().default('IN'),
  pan: text('pan'),
  tan: text('tan'),
  gstin: text('gstin'),
  registeredAddress: text('registered_address'),
  defaultCurrency: char('default_currency', { length: 3 }).notNull().default('INR'),
});

// Business units, departments and locations: a stable identity row plus dated versions (decision #21).

export const businessUnits = pgTable(
  'business_unit',
  { ...tenantColumns(), ...softDeleteColumns(), code: text('code').notNull() },
  (t) => [uniqueIndex('business_unit_code_key').on(t.tenantId, t.code)],
);

export const businessUnitVersions = pgTable(
  'business_unit_version',
  {
    ...tenantColumns(),
    ...effectiveColumns(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id),
    name: text('name').notNull(),
    headPersonId: uuid('head_person_id'),
  },
  (t) => [index('business_unit_version_unit_idx').on(t.businessUnitId)],
);

export const departments = pgTable(
  'department',
  { ...tenantColumns(), ...softDeleteColumns(), code: text('code').notNull() },
  (t) => [uniqueIndex('department_code_key').on(t.tenantId, t.code)],
);

export const departmentVersions = pgTable(
  'department_version',
  {
    ...tenantColumns(),
    ...effectiveColumns(),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    name: text('name').notNull(),
    businessUnitId: uuid('business_unit_id')
      .notNull()
      .references(() => businessUnits.id),
    parentDepartmentId: uuid('parent_department_id').references(() => departments.id),
    headPersonId: uuid('head_person_id'),
  },
  (t) => [index('department_version_unit_idx').on(t.departmentId)],
);

export const locationTypes = ['office', 'client_site', 'remote'] as const;

export const locations = pgTable(
  'location',
  {
    ...tenantColumns(),
    ...softDeleteColumns(),
    code: text('code').notNull(),
    legalEntityId: uuid('legal_entity_id')
      .notNull()
      .references(() => legalEntities.id),
  },
  (t) => [uniqueIndex('location_code_key').on(t.tenantId, t.code)],
);

export const locationVersions = pgTable(
  'location_version',
  {
    ...tenantColumns(),
    ...effectiveColumns(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    name: text('name').notNull(),
    type: text('type', { enum: locationTypes }).notNull(),
    address: text('address'),
    state: text('state'),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    /** Holiday calendars arrive in slice 6. */
    holidayCalendarId: uuid('holiday_calendar_id'),
    seatCount: integer('seat_count'),
  },
  (t) => [index('location_version_unit_idx').on(t.locationId)],
);

export const costCentres = pgTable(
  'cost_centre',
  {
    ...tenantColumns(),
    ...softDeleteColumns(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    ownerPersonId: uuid('owner_person_id'),
  },
  (t) => [uniqueIndex('cost_centre_code_key').on(t.tenantId, t.code)],
);

export const grades = pgTable(
  'grade',
  {
    ...tenantColumns(),
    ...softDeleteColumns(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** Annual CTC band in paise (decision #22). */
    bandMin: money('band_min'),
    bandMax: money('band_max'),
    currency: char('currency', { length: 3 }).notNull().default('INR'),
    levelOrder: integer('level_order').notNull(),
  },
  (t) => [uniqueIndex('grade_code_key').on(t.tenantId, t.code)],
);

export const designationBands = ['associate', 'senior_lead', 'manager_plus'] as const;

export const designations = pgTable('designation', {
  ...tenantColumns(),
  ...softDeleteColumns(),
  title: text('title').notNull(),
  gradeId: uuid('grade_id')
    .notNull()
    .references(() => grades.id),
  designationBand: text('designation_band', { enum: designationBands }).notNull(),
});

export const positionStatuses = ['open', 'filled', 'frozen'] as const;

export const positions = pgTable(
  'position',
  {
    ...tenantColumns(),
    ...softDeleteColumns(),
    code: text('code').notNull(),
    designationId: uuid('designation_id')
      .notNull()
      .references(() => designations.id),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    costCentreId: uuid('cost_centre_id').references(() => costCentres.id),
    status: text('status', { enum: positionStatuses }).notNull().default('open'),
    budgetedCtc: money('budgeted_ctc'),
    currency: char('currency', { length: 3 }).notNull().default('INR'),
  },
  (t) => [uniqueIndex('position_code_key').on(t.tenantId, t.code)],
);
