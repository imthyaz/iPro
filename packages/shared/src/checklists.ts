import { z } from 'zod';
import { isoDateSchema, roleSchema } from './identity.js';
import { engagementTypeSchema } from './people.js';

/** `access` is IT housekeeping, e.g. removing a pre-joiner's guest account (decision #58). */
export const checklistStageSchema = z.enum(['onboarding', 'exit', 'transfer', 'access']);

/**
 * Who does a task: the person it's about, their manager, anyone holding a role (e.g. HR), or a named
 * user (e.g. the IT admin) — decision #15: IT, buddies and department owners are assignees, not roles.
 */
export const taskOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('employee') }),
  z.object({ kind: z.literal('manager') }),
  z.object({ kind: z.literal('role'), role: roleSchema }),
  z.object({ kind: z.literal('user'), userId: z.uuid(), label: z.string().trim().min(1).max(60) }),
]);
export type TaskOwner = z.infer<typeof taskOwnerSchema>;

export const templateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  owner: taskOwnerSchema,
  /** Days after the anchor date (joining day, last working day…); negative = before it. */
  dueOffsetDays: z.number().int().min(-180).max(365),
  mandatory: z.boolean(),
  requiresDocument: z.boolean(),
});

/** Who a template applies to; an empty filter means everyone. */
export const appliesToSchema = z.object({
  legalEntityIds: z.array(z.uuid()).optional(),
  engagementTypes: z.array(engagementTypeSchema).optional(),
  departmentIds: z.array(z.uuid()).optional(),
  locationIds: z.array(z.uuid()).optional(),
});
export type AppliesTo = z.infer<typeof appliesToSchema>;

/** PUT /api/checklist-templates/:key — saving creates a new version; running checklists keep theirs. */
export const checklistTemplateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  stage: checklistStageSchema,
  appliesTo: appliesToSchema,
  tasks: z.array(templateTaskSchema).min(1).max(60),
});
export type ChecklistTemplateInput = z.infer<typeof checklistTemplateSchema>;

export const startChecklistSchema = z.object({
  templateKey: z.string().min(1).max(60),
  /** The date due offsets count from, e.g. the joining date. */
  anchorDate: isoDateSchema,
});

export const completeTaskSchema = z.object({
  evidenceDocumentId: z.uuid().optional(),
  note: z.string().trim().max(500).optional(),
});
export const waiveTaskSchema = z.object({ reason: z.string().trim().min(1).max(500) });
export const cancelRunSchema = z.object({ reason: z.string().trim().min(1).max(500) });

export interface ChecklistTaskView {
  id: string;
  title: string;
  owner: string;
  dueOn: string;
  overdue: boolean;
  mandatory: boolean;
  requiresDocument: boolean;
  status: 'open' | 'done' | 'waived';
  doneBy: string | null;
  doneAt: string | null;
  evidenceDocumentId: string | null;
  note: string | null;
  waiveReason: string | null;
}

export interface ChecklistRunView {
  id: string;
  templateName: string;
  templateVersion: number;
  stage: z.infer<typeof checklistStageSchema>;
  person: { personId: string; name: string };
  anchorDate: string;
  status: 'open' | 'complete' | 'cancelled';
  startedAt: string;
  completedAt: string | null;
  progress: { done: number; total: number; overdue: number };
  tasks: ChecklistTaskView[];
}

/** A task waiting on the signed-in user (Action inbox, slice 11). */
export interface MyTaskView extends ChecklistTaskView {
  runId: string;
  checklist: string;
  person: { personId: string; name: string };
}
