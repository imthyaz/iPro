import { z } from 'zod';
import { appliesToSchema } from './checklists.js';
import { isoDateSchema } from './identity.js';

/** POST /api/policies — a policy and who it applies to (admins and HR head). */
export const policyInputSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/),
  title: z.string().trim().min(1).max(200),
  appliesTo: appliesToSchema,
  requiresAcknowledgement: z.boolean(),
});
export type PolicyInput = z.infer<typeof policyInputSchema>;

/** Multipart fields with POST /api/policies/:id/versions (the PDF is the `file` part). */
export const publishVersionSchema = z.object({
  effectiveFrom: isoDateSchema,
  summary: z.string().trim().max(1000).optional(),
});

/** POST /api/policies/versions/:id/accept — the hash of the version the person read. */
export const acceptPolicySchema = z.object({ contentHash: z.string().regex(/^[0-9a-f]{64}$/) });

export interface PolicyVersionView {
  id: string;
  version: number;
  effectiveFrom: string;
  summary: string | null;
  fileName: string;
  contentHash: string;
  publishedAt: string;
}

/** A policy as an employee sees it (E11 policy sign-offs, E1 pending items). */
export interface MyPolicyView {
  policyId: string;
  code: string;
  title: string;
  requiresAcknowledgement: boolean;
  current: PolicyVersionView;
  acceptedAt: string | null;
  /** True when the current version still needs this person's acceptance. */
  pending: boolean;
}

/** HR's view of a policy: who has accepted the current version and who hasn't (spec: HR sees pending). */
export interface PolicyStatusView {
  policyId: string;
  code: string;
  title: string;
  appliesTo: z.infer<typeof appliesToSchema>;
  requiresAcknowledgement: boolean;
  current: PolicyVersionView | null;
  versions: PolicyVersionView[];
  accepted: { personId: string; name: string; acceptedAt: string }[];
  pending: { personId: string; name: string; employeeCode: string }[];
}
