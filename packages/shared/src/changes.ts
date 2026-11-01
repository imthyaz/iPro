import { z } from 'zod';
import { isoDateSchema } from './identity.js';

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
