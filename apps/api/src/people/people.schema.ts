import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { softDeleteColumns, tenantColumns } from '../db/columns.js';
import { tenants } from '../db/tenant.schema.js';
import {
  costCentres,
  departments,
  designations,
  grades,
  legalEntities,
  locations,
  positions,
} from '../org/org.schema.js';

export const engagementTypes = [
  'permanent',
  'fixed_term',
  'intern',
  'trainee',
  'retainer',
  'consultant',
] as const;
export const engagementStatuses = [
  'offered',
  'pre_joining',
  'active',
  'on_notice',
  'exited',
  'withdrawn',
] as const;
export const rateUnits = ['year', 'month', 'day', 'hour'] as const;

/** Who a person is. Never deleted except by the retention job. */
export const persons = pgTable('person', {
  ...tenantColumns(),
  ...softDeleteColumns(),
  legalName: text('legal_name').notNull(),
  preferredName: text('preferred_name'),
  dateOfBirth: date('date_of_birth'),
  gender: text('gender'),
  nationality: text('nationality'),
  personalEmail: text('personal_email'),
  phone: text('phone'),
  photoDocumentId: uuid('photo_document_id'),
  priorExperienceMonths: integer('prior_experience_months'),
});

export const emergencyContacts = pgTable(
  'emergency_contact',
  {
    ...tenantColumns(),
    ...softDeleteColumns(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    name: text('name').notNull(),
    relation: text('relation').notNull(),
    phone: text('phone').notNull(),
  },
  (t) => [index('emergency_contact_person_idx').on(t.personId)],
);

/** The contract a person works under. A conversion or rehire is a new engagement for the same person. */
export const engagements = pgTable(
  'engagement',
  {
    ...tenantColumns(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    employeeCode: text('employee_code').notNull(),
    legalEntityId: uuid('legal_entity_id')
      .notNull()
      .references(() => legalEntities.id),
    type: text('type', { enum: engagementTypes }).notNull(),
    status: text('status', { enum: engagementStatuses }).notNull(),
    /** Work (Entra) sign-in name; links a user to this person (decision #34). */
    workEmail: text('work_email'),
    offerDate: date('offer_date'),
    joiningDate: date('joining_date').notNull(),
    probationEndDate: date('probation_end_date'),
    confirmationDate: date('confirmation_date'),
    noticePeriodDays: integer('notice_period_days'),
    resignationDate: date('resignation_date'),
    /** Planned last day of an internship or fixed-term engagement (decision #56). */
    contractEndDate: date('contract_end_date'),
    lastWorkingDate: date('last_working_date'),
    exitReason: text('exit_reason'),
    rehireEligible: boolean('rehire_eligible'),
    /** The engagement this one continues (retainer-to-payroll conversion). */
    previousEngagementId: uuid('previous_engagement_id'),
  },
  (t) => [
    index('engagement_person_idx').on(t.personId),
    // A code belongs to one continuous service: shared only along a conversion chain (decision #19).
    index('engagement_employee_code_idx').on(t.tenantId, t.employeeCode),
    uniqueIndex('engagement_work_email_live_key')
      .on(t.tenantId, sql`lower(${t.workEmail})`)
      .where(sql`${t.status} in ('offered', 'pre_joining', 'active', 'on_notice')`),
  ],
);

/** Effective-dated facts about an engagement: exactly one row in force on any date (exclusion constraint). */
export const assignments = pgTable(
  'assignment',
  {
    ...tenantColumns(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    designationId: uuid('designation_id')
      .notNull()
      .references(() => designations.id),
    gradeId: uuid('grade_id')
      .notNull()
      .references(() => grades.id),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    costCentreId: uuid('cost_centre_id').references(() => costCentres.id),
    managerEngagementId: uuid('manager_engagement_id').references(() => engagements.id),
    dottedManagerEngagementId: uuid('dotted_manager_engagement_id').references(
      () => engagements.id,
    ),
    bucket: text('bucket').notNull(),
    /** Hybrid work policies arrive in slice 8. */
    workPolicyId: uuid('work_policy_id'),
    positionId: uuid('position_id').references(() => positions.id),
    changeReason: text('change_reason').notNull(),
  },
  (t) => [
    index('assignment_engagement_idx').on(t.engagementId),
    index('assignment_manager_idx').on(t.managerEngagementId),
  ],
);

/** Effective-dated pay. The amount is field-encrypted paise (decision #31); HR, HR head, CXO and self only. */
export const compensations = pgTable(
  'compensation',
  {
    ...tenantColumns(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    amountEncrypted: text('amount_encrypted').notNull(),
    rateUnit: text('rate_unit', { enum: rateUnits }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('INR'),
  },
  (t) => [index('compensation_engagement_idx').on(t.engagementId)],
);

/** Last employee code issued per tenant; codes are never reused. */
export const employeeCodeCounters = pgTable('employee_code_counter', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  lastValue: integer('last_value').notNull().default(0),
});

/** HR policy settings (CLAUDE.md: configuration rows, never constants). Defaults from the spec's rules table. */
export const tenantSettings = pgTable(
  'tenant_setting',
  {
    ...tenantColumns(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
  },
  (t) => [uniqueIndex('tenant_setting_key').on(t.tenantId, t.key)],
);
