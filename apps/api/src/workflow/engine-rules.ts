import type { RoleGrant, WorkflowDefinition } from '@ipro/shared';

type Step = WorkflowDefinition['steps'][number];

/** The first step at or after `from` whose condition holds for the payload; -1 when none is left. */
export function nextStepIndex(
  steps: readonly Step[],
  from: number,
  payload: Record<string, unknown>,
): number {
  for (let i = from; i < steps.length; i += 1) {
    const when = steps[i]!.when;
    if (!when || payload[when.field] === when.equals) return i;
  }
  return -1;
}

export interface OpenApproval {
  assignedUserId: string | null;
  assignedRole: RoleGrant['role'] | null;
  assignedLegalEntityId: string | null;
  escalatedToUserId: string | null;
  escalatedToRole: RoleGrant['role'] | null;
}

export type Capacity = { as: 'approver' } | { as: 'delegate'; onBehalfOf: string } | null;

const holdsRole = (roles: RoleGrant[], role: RoleGrant['role'], legalEntityId: string | null) =>
  roles.some(
    (grant) =>
      grant.role === role &&
      (grant.legalEntityId === null || grant.legalEntityId === legalEntityId),
  );

/**
 * In what capacity a user may decide an approval: as the approver (assigned, holding the assigned
 * role, or escalated to), or as a delegate of the assigned approver for today. Submitters never
 * decide their own requests.
 */
export function decisionCapacity(
  approval: OpenApproval,
  user: { userId: string; roles: RoleGrant[] },
  submittedBy: string,
  /** Users who delegated their approvals to this user for today. */
  delegators: readonly string[],
): Capacity {
  if (user.userId === submittedBy) return null;
  if (approval.assignedUserId === user.userId || approval.escalatedToUserId === user.userId) {
    return { as: 'approver' };
  }
  if (
    approval.assignedRole &&
    holdsRole(user.roles, approval.assignedRole, approval.assignedLegalEntityId)
  ) {
    return { as: 'approver' };
  }
  if (
    approval.escalatedToRole &&
    holdsRole(user.roles, approval.escalatedToRole, approval.assignedLegalEntityId)
  ) {
    return { as: 'approver' };
  }
  if (approval.assignedUserId && delegators.includes(approval.assignedUserId)) {
    return { as: 'delegate', onBehalfOf: approval.assignedUserId };
  }
  return null;
}
