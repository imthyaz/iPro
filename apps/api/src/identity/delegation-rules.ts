/** Dates are ISO `YYYY-MM-DD` business dates in the location's timezone, so string order is date order. */
export interface DelegationPeriod {
  delegatorUserId: string;
  delegateUserId: string;
  startsOn: string;
  endsOn: string;
  revokedAt?: Date | null;
}

export interface DelegationFacts {
  delegatorIsManager: boolean;
  delegateIsManager: boolean;
  /** The delegator's other delegations (revoked ones are ignored). */
  existing: DelegationPeriod[];
  today: string;
}

/** Reasons a delegation can't be created; empty when it can. */
export function delegationProblems(request: DelegationPeriod, facts: DelegationFacts): string[] {
  const problems: string[] = [];
  if (request.endsOn < request.startsOn) problems.push('End date is before start date');
  if (request.endsOn < facts.today) problems.push('Delegation is entirely in the past');
  if (request.delegateUserId === request.delegatorUserId)
    problems.push('Cannot delegate to yourself');
  if (!facts.delegatorIsManager) problems.push('Only managers delegate approvals');
  if (!facts.delegateIsManager) problems.push('Approvals can only be delegated to another manager');
  const overlaps = facts.existing.some(
    (other) =>
      !other.revokedAt && other.startsOn <= request.endsOn && request.startsOn <= other.endsOn,
  );
  if (overlaps) problems.push('Overlaps an existing delegation');
  return problems;
}

/**
 * Who may act on an approval assigned to `approverUserId` on `onDate`: the approver plus anyone they
 * delegated to for that date. Delegations are not followed further (no chains).
 */
export function effectiveApprovers(
  approverUserId: string,
  onDate: string,
  delegations: DelegationPeriod[],
): string[] {
  const delegates = delegations
    .filter(
      (d) =>
        d.delegatorUserId === approverUserId &&
        !d.revokedAt &&
        d.startsOn <= onDate &&
        onDate <= d.endsOn,
    )
    .map((d) => d.delegateUserId);
  return [approverUserId, ...new Set(delegates)];
}
