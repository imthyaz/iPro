import { z } from 'zod';
import { isoDateSchema } from './identity.js';
import { paiseSchema } from './org.js';
import { convertEngagementSchema, rateUnitSchema } from './people.js';

/**
 * POST /api/people/:id/changes (H6, spec workflow 8): an in-life change of role, effective from a
 * date, approved by HR head before it applies (decision #62). Only the fields that change are sent.
 */
export const inLifeChangeSchema = z
  .object({
    effectiveFrom: isoDateSchema,
    reason: z.string().trim().min(1).max(200),
    designationId: z.uuid().optional(),
    departmentId: z.uuid().optional(),
    locationId: z.uuid().optional(),
    /** null removes the manager. */
    managerEngagementId: z.uuid().nullable().optional(),
    bucket: z.string().min(1).optional(),
    /** A letter to generate on approval (e.g. a transfer or promotion letter), read as of the date. */
    letterTemplateKey: z.string().min(1).max(60).optional(),
    extra: z.record(z.string().regex(/^[a-zA-Z]\w{0,40}$/), z.string().max(500)).optional(),
  })
  .refine(
    (c) =>
      c.designationId !== undefined ||
      c.departmentId !== undefined ||
      c.locationId !== undefined ||
      c.managerEngagementId !== undefined ||
      c.bucket !== undefined,
    { message: 'change at least one thing' },
  );
export type InLifeChangeInput = z.infer<typeof inLifeChangeSchema>;

/**
 * POST /api/people/:id/pay-changes (decision #64): new pay from a date, e.g. an unpaid intern
 * becoming paid. HR head approves; the amount is encrypted inside the request.
 */
export const payChangeSchema = z.object({
  effectiveFrom: isoDateSchema,
  reason: z.string().trim().min(1).max(200),
  amount: paiseSchema,
  rateUnit: rateUnitSchema,
  letterTemplateKey: z.string().min(1).max(60).optional(),
  extra: z.record(z.string().regex(/^[a-zA-Z]\w{0,40}$/), z.string().max(500)).optional(),
});
export type PayChangeInput = z.infer<typeof payChangeSchema>;

/**
 * POST /api/people/:id/conversion-requests (decisions #41, #42, #64): retainer or consultant to
 * payroll, or intern or trainee to employee. HR head, then CXO, approve; a future date is scheduled.
 */
export const conversionRequestSchema = convertEngagementSchema.extend({
  reason: z.string().trim().min(1).max(200),
});
export type ConversionRequestInput = z.infer<typeof conversionRequestSchema>;

export type ChangeRequestResult = { requestId: string } | { applied: true };
