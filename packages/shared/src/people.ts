import { z } from 'zod';
import { isoDateSchema } from './identity.js';
import { currencySchema, paiseSchema } from './org.js';

export const engagementTypeSchema = z.enum([
  'permanent',
  'fixed_term',
  'intern',
  'trainee',
  'retainer',
  'consultant',
]);
export const engagementStatusSchema = z.enum([
  'offered',
  'pre_joining',
  'active',
  'on_notice',
  'exited',
  'withdrawn',
]);
export const rateUnitSchema = z.enum(['year', 'month', 'day', 'hour']);

const name = z.string().trim().min(1).max(200);
const optional = z.string().trim().min(1).max(200).nullish();

export const personFieldsSchema = z.object({
  legalName: name,
  preferredName: optional,
  dateOfBirth: isoDateSchema.nullish(),
  gender: optional,
  nationality: optional,
  personalEmail: z.email().nullish(),
  phone: z.string().trim().min(5).max(30).nullish(),
  priorExperienceMonths: z.number().int().min(0).max(720).nullish(),
});

/** Assignment facts, minus the grade (taken from the designation). */
export const assignmentFieldsSchema = z.object({
  designationId: z.uuid(),
  departmentId: z.uuid(),
  locationId: z.uuid(),
  costCentreId: z.uuid().nullish(),
  managerEngagementId: z.uuid().nullish(),
  dottedManagerEngagementId: z.uuid().nullish(),
  bucket: z.string().min(1),
  positionId: z.uuid().nullish(),
});

export const compensationInputSchema = z.object({
  amount: paiseSchema,
  rateUnit: rateUnitSchema,
  currency: currencySchema.optional(),
});

/** POST /api/people: person, engagement and first assignment in one step (screen H2 "new person"). */
export const createPersonSchema = z.object({
  person: personFieldsSchema,
  engagement: z.object({
    legalEntityId: z.uuid(),
    type: engagementTypeSchema,
    workEmail: z.email().nullish(),
    joiningDate: isoDateSchema,
    offerDate: isoDateSchema.nullish(),
  }),
  assignment: assignmentFieldsSchema,
  compensation: compensationInputSchema.optional(),
});
export type CreatePersonInput = z.infer<typeof createPersonSchema>;

/** POST /api/people/:id/assignments: new facts effective from a date; unsent fields carry forward. */
export const changeAssignmentSchema = assignmentFieldsSchema.partial().extend({
  engagementId: z.uuid().optional(),
  effectiveFrom: isoDateSchema,
  changeReason: z.string().trim().min(1).max(200),
});
export type ChangeAssignmentInput = z.infer<typeof changeAssignmentSchema>;

export const changeCompensationSchema = compensationInputSchema.extend({
  engagementId: z.uuid().optional(),
  effectiveFrom: isoDateSchema,
});
export type ChangeCompensationInput = z.infer<typeof changeCompensationSchema>;

export const emergencyContactInputSchema = z.object({
  name,
  relation: z.string().trim().min(1).max(50),
  phone: z.string().trim().min(5).max(30),
});

export const peopleQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  departmentId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  status: engagementStatusSchema.optional(),
  asOf: isoDateSchema.optional(),
});

/** A row of the people directory (H1) and the header of a person record (H2/E7). */
export interface PersonSummary {
  personId: string;
  legalName: string;
  preferredName: string | null;
  employeeCode: string;
  engagementId: string;
  engagementType: z.infer<typeof engagementTypeSchema>;
  status: z.infer<typeof engagementStatusSchema>;
  joiningDate: string;
  legalEntityId: string;
  workEmail: string | null;
  designation: { id: string; title: string } | null;
  department: { id: string; name: string } | null;
  location: { id: string; name: string } | null;
  manager: { engagementId: string; personId: string; name: string } | null;
  bucket: string | null;
}

/** GET /api/org-tree?asOf= (screen H10). Flat lists; parents point at ids in the same list. */
export interface OrgTree {
  asOf: string;
  people: {
    personId: string;
    name: string;
    employeeCode: string;
    engagementType: z.infer<typeof engagementTypeSchema>;
    designation: string;
    departmentId: string;
    departmentName: string;
    /** null for roots, including people whose manager the viewer may not see. */
    managerPersonId: string | null;
  }[];
  departments: {
    departmentId: string;
    name: string;
    parentDepartmentId: string | null;
    businessUnitId: string;
    businessUnitName: string;
    /** People in the department that the viewer may see. */
    headcount: number;
  }[];
}

/** POST /api/people/:id/convert: retainer (or consultant) to payroll, same person and employee code. */
export const convertEngagementSchema = z.object({
  effectiveFrom: isoDateSchema,
  type: z.enum(['permanent', 'fixed_term']),
  /** Assignment facts that change with the conversion; the rest carry forward. */
  assignment: assignmentFieldsSchema.partial().optional(),
  compensation: compensationInputSchema.optional(),
});
export type ConvertEngagementInput = z.infer<typeof convertEngagementSchema>;

/** GET /api/people/:id/journey: one timeline across all of a person's engagements. */
export interface JourneyEntry {
  id: string;
  engagementId: string;
  employeeCode: string;
  eventType: string;
  category: string;
  occurredOn: string;
  isPlanned: boolean;
  title: string;
  sensitivity: 'public' | 'manager' | 'hr' | 'restricted';
  migrated: boolean;
}
