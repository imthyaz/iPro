import { z } from 'zod';
import { isoDateSchema } from './identity.js';

/** Money in JSON: whole paise as a decimal string (JSON numbers can't carry bigint safely). */
export const paiseSchema = z.string().regex(/^\d{1,15}$/, 'whole paise as digits');
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const optionalText = z.string().trim().min(1).max(500).nullish();
const code = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/);

export const legalEntityInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  pan: optionalText,
  tan: optionalText,
  gstin: optionalText,
  registeredAddress: optionalText,
  defaultCurrency: currencySchema.optional(),
});
export type LegalEntityInput = z.infer<typeof legalEntityInputSchema>;

// Dated org units: create with a code and the first version; change from a date; close on a date.

export const businessUnitFieldsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  headPersonId: z.uuid().nullish(),
});

export const departmentFieldsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  businessUnitId: z.uuid(),
  parentDepartmentId: z.uuid().nullish(),
  headPersonId: z.uuid().nullish(),
});

export const locationTypeSchema = z.enum(['office', 'client_site', 'remote']);
export const locationFieldsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: locationTypeSchema,
  address: optionalText,
  state: optionalText,
  timezone: z.string().min(1).optional(),
  seatCount: z.number().int().min(0).nullish(),
});

const createDated = <T extends z.ZodRawShape>(fields: z.ZodObject<T>) =>
  fields.extend({ code, effectiveFrom: isoDateSchema });
const changeDated = <T extends z.ZodRawShape>(fields: z.ZodObject<T>) =>
  fields.partial().extend({ effectiveFrom: isoDateSchema });

export const createBusinessUnitSchema = createDated(businessUnitFieldsSchema);
export const changeBusinessUnitSchema = changeDated(businessUnitFieldsSchema);
export const createDepartmentSchema = createDated(departmentFieldsSchema);
export const changeDepartmentSchema = changeDated(departmentFieldsSchema);
export const createLocationSchema = createDated(locationFieldsSchema).extend({
  legalEntityId: z.uuid(),
});
export const changeLocationSchema = changeDated(locationFieldsSchema);
export const closeDatedSchema = z.object({ effectiveTo: isoDateSchema });

export const asOfQuerySchema = z.object({ asOf: isoDateSchema.optional() });

export const costCentreInputSchema = z.object({
  code,
  name: z.string().trim().min(1).max(200),
  ownerPersonId: z.uuid().nullish(),
});

const bandInOrder = (g: { bandMin?: string | null; bandMax?: string | null }) =>
  !g.bandMin || !g.bandMax || BigInt(g.bandMax) >= BigInt(g.bandMin);
const bandMessage = { path: ['bandMax'], message: 'band max is below band min' };

/** Plain fields (zod can't make a refined object partial); use the refined schemas below. */
export const gradeFieldsSchema = z.object({
  code,
  name: z.string().trim().min(1).max(200),
  bandMin: paiseSchema.nullish(),
  bandMax: paiseSchema.nullish(),
  currency: currencySchema.optional(),
  levelOrder: z.number().int(),
});
export const gradeInputSchema = gradeFieldsSchema.refine(bandInOrder, bandMessage);
/** When only one bound is sent, the database check compares it with the stored one. */
export const gradeUpdateSchema = gradeFieldsSchema.partial().refine(bandInOrder, bandMessage);

export const designationBandSchema = z.enum(['associate', 'senior_lead', 'manager_plus']);
export const designationInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  gradeId: z.uuid(),
  designationBand: designationBandSchema,
});

export const positionInputSchema = z.object({
  code,
  designationId: z.uuid(),
  departmentId: z.uuid(),
  costCentreId: z.uuid().nullish(),
  status: z.enum(['open', 'filled', 'frozen']).optional(),
  budgetedCtc: paiseSchema.nullish(),
  currency: currencySchema.optional(),
});
