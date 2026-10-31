import { z } from 'zod';
import { roleSchema } from './identity.js';

/** Who approves a step: the subject's manager, their manager's manager, or anyone holding a role. */
export const approverSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manager') }),
  z.object({ kind: z.literal('manager_of_manager') }),
  z.object({ kind: z.literal('role'), role: roleSchema }),
]);
export type Approver = z.infer<typeof approverSchema>;

const slug = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z][a-z0-9_.]*$/);

export const workflowStepSchema = z.object({
  id: slug,
  label: z.string().trim().min(1).max(100),
  approver: approverSchema,
  /** The permission the approver must hold over the subject, e.g. profile/update for HR. */
  authorize: z.object({ area: z.string().min(1), action: z.string().min(1) }),
  /** Only run this step when a payload field has this value (e.g. aboveBand = true). */
  when: z
    .object({ field: z.string().min(1), equals: z.union([z.string(), z.number(), z.boolean()]) })
    .optional(),
});

/** A workflow as configuration (decision #49). Edited by admins; each save is a new version. */
export const workflowDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    steps: z.array(workflowStepSchema).min(1).max(10),
    /** Overrides the tenant's escalation window (spec default 3 working days). */
    escalationWorkingDays: z.number().int().min(1).max(30).optional(),
    reminderWorkingDays: z.number().int().min(1).max(30).optional(),
    /** What happens on final approval: a named action the system provides (e.g. profile.apply). */
    onApproved: slug,
    /** A journey event written on final approval, if the workflow is part of a person's journey. */
    journey: z
      .object({
        eventType: slug,
        category: z.string().min(1).max(40),
        title: z.string().min(1).max(200),
        sensitivity: z.enum(['public', 'manager', 'hr', 'restricted']),
      })
      .optional(),
  })
  .refine((d) => new Set(d.steps.map((s) => s.id)).size === d.steps.length, {
    path: ['steps'],
    message: 'step ids must be unique',
  });
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export const saveWorkflowDefinitionSchema = z.object({
  key: slug,
  definition: workflowDefinitionSchema,
});

/** POST /api/workflows: start an item of a workflow whose action allows generic submission. */
export const submitWorkflowSchema = z.object({
  key: slug,
  subjectPersonId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const rejectSchema = z.object({ comment: z.string().trim().min(1).max(2000) });
export const approveSchema = z.object({ comment: z.string().trim().max(2000).optional() });
export const commentSchema = z.object({ body: z.string().trim().min(1).max(2000) });

/** POST /api/people/:id/profile-change: personal details, applied once HR approves. */
export const profileChangeSchema = z
  .object({
    preferredName: z.string().trim().min(1).max(200).nullable().optional(),
    personalEmail: z.email().nullable().optional(),
    phone: z.string().trim().min(5).max(30).nullable().optional(),
    nationality: z.string().trim().min(1).max(100).nullable().optional(),
    gender: z.string().trim().min(1).max(50).nullable().optional(),
  })
  .refine((c) => Object.keys(c).length > 0, 'change at least one field');
export type ProfileChange = z.infer<typeof profileChangeSchema>;

/** A field as it is and as requested, so the approver decides on the card itself. */
export interface ChangeLine {
  label: string;
  from: string | null;
  to: string | null;
}

/** An approval waiting on the signed-in user (approval card: everything needed to decide). */
export interface ApprovalCard {
  approvalId: string;
  instanceId: string;
  key: string;
  title: string;
  stepLabel: string;
  subject: { personId: string; name: string };
  submittedBy: string;
  submittedAt: string;
  dueOn: string;
  overdue: boolean;
  escalated: boolean;
  /** Set when the signed-in user would decide for someone who delegated to them. */
  onBehalfOf: string | null;
  changes: ChangeLine[];
}

export interface WorkflowView {
  id: string;
  key: string;
  title: string;
  status: 'pending' | 'returned' | 'approved' | 'withdrawn';
  subject: { personId: string; name: string };
  submittedBy: { userId: string; name: string };
  submittedAt: string;
  completedAt: string | null;
  changes: ChangeLine[];
  steps: {
    approvalId: string;
    label: string;
    assignedTo: string;
    dueOn: string;
    escalatedTo: string | null;
    decision: 'approved' | 'rejected' | null;
    decidedBy: string | null;
    onBehalfOf: string | null;
    decidedAt: string | null;
    comment: string | null;
    closed: boolean;
  }[];
  comments: { id: string; author: string; body: string; at: string }[];
  /** What the signed-in user may do now. */
  canWithdraw: boolean;
  canResubmit: boolean;
}

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  link: string | null;
  createdAt: string;
  read: boolean;
}
