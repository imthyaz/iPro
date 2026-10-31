import type { Role } from '@ipro/shared';

/** Rows of the spec's permissions table, plus approval delegation (decision #27). */
export const dataAreas = [
  'profile',
  'kyc',
  'compensation',
  'assignment_history',
  'attendance',
  'leave',
  'hybrid_booking',
  'documents',
  'journey_public',
  'journey_sensitive',
  'probation_review',
  'exit',
  'org_config',
  'users_roles',
  'audit_log',
  'approval_delegation',
] as const;
export type DataArea = (typeof dataAreas)[number];

/** R, C, U, A, D from the spec, plus the named actions its cells use. */
export const actions = [
  'read',
  'create',
  'update',
  'approve',
  'delete',
  'unmask',
  'verify',
  'regularise',
  'cancel',
  'withdraw',
  'terminate',
] as const;
export type Action = (typeof actions)[number];

/**
 * own: the actor's own record. team: direct and indirect solid-line reportees (decision #18).
 * entity: everyone in the legal entities the role is granted for.
 */
export type Scope = 'own' | 'team' | 'entity';

/** Must hold on the resource for the grant to apply. A missing attribute counts as not holding. */
export type Condition =
  | 'before_cutoff' // hybrid bookings: "U before cut-off"
  | 'non_confidential' // documents: "R non-confidential"
  | 'after_decision' // probation review: "R after decision"
  | 'own_actions'; // audit log: "R own actions"

/** What the caller must do when the grant applies (shape of the response or the input). */
export type Obligation =
  | 'mask' // KYC: last 4 only; unmasking is its own audited action
  | 'aggregates_only' // CXO attendance, leave, hybrid: totals, no per-person rows
  | 'requires_reason' // HR updates to attendance and leave balances
  | 'via_change_request'; // employee profile updates go through a request HR approves

export interface Grant {
  area: DataArea;
  actions: readonly Action[];
  scope: Scope;
  conditions?: readonly Condition[];
  obligations?: readonly Obligation[];
}

const g = (
  area: DataArea,
  scope: Scope,
  grantActions: readonly Action[],
  extra: Pick<Grant, 'conditions' | 'obligations'> = {},
): Grant => ({ area, scope, actions: grantActions, ...extra });

/** The spec's permissions table. Anything not listed is denied. */
export const permissions: Record<Role, readonly Grant[]> = {
  employee: [
    g('profile', 'own', ['read']),
    g('profile', 'own', ['update'], { obligations: ['via_change_request'] }),
    g('kyc', 'own', ['read'], { obligations: ['mask'] }),
    g('kyc', 'own', ['create']),
    g('compensation', 'own', ['read']),
    g('assignment_history', 'own', ['read']),
    g('attendance', 'own', ['read', 'create', 'regularise']),
    g('leave', 'own', ['create', 'read', 'cancel']),
    g('hybrid_booking', 'own', ['create', 'read']),
    g('hybrid_booking', 'own', ['update'], { conditions: ['before_cutoff'] }),
    g('documents', 'own', ['read']),
    g('journey_public', 'own', ['read']),
    g('journey_sensitive', 'own', ['read']),
    g('probation_review', 'own', ['read'], { conditions: ['after_decision'] }),
    g('exit', 'own', ['create', 'withdraw']),
  ],
  manager: [
    g('profile', 'team', ['read']),
    g('assignment_history', 'team', ['read']),
    g('attendance', 'team', ['read', 'approve']),
    g('leave', 'team', ['read', 'approve']),
    g('hybrid_booking', 'team', ['read', 'approve']),
    g('documents', 'team', ['read'], { conditions: ['non_confidential'] }),
    g('journey_public', 'team', ['read']),
    g('probation_review', 'team', ['create', 'read']),
    g('exit', 'team', ['read', 'approve']),
    g('approval_delegation', 'own', ['create', 'read', 'update']),
  ],
  hr: [
    g('profile', 'entity', ['read', 'update']),
    g('kyc', 'entity', ['read'], { obligations: ['mask'] }),
    g('kyc', 'entity', ['unmask', 'update', 'verify']),
    g('compensation', 'entity', ['read', 'create', 'update']),
    g('assignment_history', 'entity', ['read', 'create', 'update']),
    g('attendance', 'entity', ['read']),
    g('attendance', 'entity', ['update'], { obligations: ['requires_reason'] }),
    g('leave', 'entity', ['read']),
    g('leave', 'entity', ['update'], { obligations: ['requires_reason'] }),
    g('hybrid_booking', 'entity', ['read']),
    g('documents', 'entity', ['create', 'read', 'update']),
    g('journey_public', 'entity', ['read']),
    g('journey_sensitive', 'entity', ['read']),
    g('probation_review', 'entity', ['read', 'approve']),
    g('exit', 'entity', ['read', 'update', 'approve']),
    g('org_config', 'entity', ['read']),
    g('users_roles', 'entity', ['read']),
    g('audit_log', 'entity', ['read'], { conditions: ['own_actions'] }),
    g('approval_delegation', 'entity', ['create', 'read', 'update']),
  ],
  hr_head: [
    g('profile', 'entity', ['read', 'update']),
    g('kyc', 'entity', ['read'], { obligations: ['mask'] }),
    g('kyc', 'entity', ['unmask', 'update']),
    g('compensation', 'entity', ['read', 'create', 'update', 'approve']),
    g('assignment_history', 'entity', ['read', 'create', 'update', 'approve']),
    g('attendance', 'entity', ['read', 'update']),
    g('leave', 'entity', ['read', 'update']),
    g('hybrid_booking', 'entity', ['read']),
    g('documents', 'entity', ['create', 'read', 'update']),
    g('journey_public', 'entity', ['read']),
    g('journey_sensitive', 'entity', ['read']),
    g('probation_review', 'entity', ['read', 'terminate']),
    g('exit', 'entity', ['read', 'approve', 'terminate']),
    g('org_config', 'entity', ['read', 'update']),
    g('users_roles', 'entity', ['read']),
    g('audit_log', 'entity', ['read']),
    g('approval_delegation', 'entity', ['create', 'read', 'update']),
  ],
  cxo: [
    g('profile', 'entity', ['read']),
    g('compensation', 'entity', ['read']),
    g('assignment_history', 'entity', ['read']),
    g('attendance', 'entity', ['read'], { obligations: ['aggregates_only'] }),
    g('leave', 'entity', ['read'], { obligations: ['aggregates_only'] }),
    g('hybrid_booking', 'entity', ['read'], { obligations: ['aggregates_only'] }),
    g('journey_public', 'entity', ['read']),
    g('journey_sensitive', 'entity', ['read']),
    g('exit', 'entity', ['read']),
  ],
  // Admin sees configuration, not people data, unless also granted an HR role.
  admin: [
    g('org_config', 'entity', ['create', 'read', 'update', 'delete']),
    g('users_roles', 'entity', ['create', 'read', 'update', 'delete']),
    g('audit_log', 'entity', ['read']),
  ],
};
