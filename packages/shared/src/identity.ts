import { z } from 'zod';

/** Roles from the spec's permissions table. A person may hold several; grants are cumulative. */
export const roles = ['employee', 'manager', 'hr', 'hr_head', 'cxo', 'admin'] as const;
export const roleSchema = z.enum(roles);
export type Role = z.infer<typeof roleSchema>;

export const roleGrantSchema = z.object({
  role: roleSchema,
  /** null = every legal entity in the tenant. */
  legalEntityId: z.uuid().nullable(),
});
export type RoleGrant = z.infer<typeof roleGrantSchema>;

/** GET /api/me */
export const meResponseSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  roles: z.array(roleGrantSchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const isoDateSchema = z.iso.date();

/** POST /api/delegations */
export const createDelegationSchema = z.object({
  /** Omit to delegate your own approvals; HR may set it to delegate on a manager's behalf. */
  delegatorUserId: z.uuid().optional(),
  delegateUserId: z.uuid(),
  startsOn: isoDateSchema,
  endsOn: isoDateSchema,
  reason: z.string().trim().max(500).optional(),
});
export type CreateDelegationInput = z.infer<typeof createDelegationSchema>;

export const delegationSchema = z.object({
  id: z.uuid(),
  delegatorUserId: z.uuid(),
  delegateUserId: z.uuid(),
  startsOn: isoDateSchema,
  endsOn: isoDateSchema,
  reason: z.string().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type Delegation = z.infer<typeof delegationSchema>;
