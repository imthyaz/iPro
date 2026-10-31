import { roles, type Role } from '@ipro/shared';
import { describe, expect, it } from 'vitest';
import type { Actor } from '../context/request-context.js';
import { AuthzService, type Resource } from './authz.service.js';
import { actions, dataAreas, type Action, type DataArea } from './permissions.js';
import type { ScopeResolver } from './scope-resolver.js';

/**
 * The spec's permissions table, transcribed independently of permissions.ts. Codes: R read, C create,
 * U update, A approve, D delete; named actions spelled out. Qualifiers (masked, via request, with reason,
 * aggregates, before cut-off, non-confidential, after decision, own actions) are tested further down.
 * Decisions #14 (CXO reads compensation), #17 (HR and HR head unmask KYC), #27 (delegation) and
 * #39 (employees open their own KYC scans; HR and HR head open anyone’s) apply.
 */
const specTable: Record<Role, Partial<Record<DataArea, string>>> = {
  employee: {
    profile: 'R U',
    kyc: 'R C open_scan',
    compensation: 'R',
    assignment_history: 'R',
    attendance: 'R C regularise',
    leave: 'C R cancel',
    hybrid_booking: 'C R U',
    documents: 'R',
    journey_public: 'R',
    journey_sensitive: 'R',
    probation_review: 'R',
    exit: 'C withdraw',
  },
  manager: {
    profile: 'R',
    assignment_history: 'R',
    attendance: 'R A',
    leave: 'R A',
    hybrid_booking: 'R A',
    documents: 'R',
    journey_public: 'R',
    probation_review: 'C R',
    exit: 'R A',
    approval_delegation: 'C R U',
  },
  hr: {
    profile: 'R U',
    kyc: 'R U verify unmask open_scan',
    compensation: 'R C U',
    assignment_history: 'R C U',
    attendance: 'R U',
    leave: 'R U',
    hybrid_booking: 'R',
    documents: 'C R U',
    journey_public: 'R',
    journey_sensitive: 'R',
    probation_review: 'R A',
    exit: 'R U A',
    org_config: 'R',
    users_roles: 'R',
    audit_log: 'R',
    approval_delegation: 'C R U',
  },
  hr_head: {
    profile: 'R U',
    kyc: 'R U unmask open_scan',
    compensation: 'R C U A',
    assignment_history: 'R C U A',
    attendance: 'R U',
    leave: 'R U',
    hybrid_booking: 'R',
    documents: 'C R U',
    journey_public: 'R',
    journey_sensitive: 'R',
    probation_review: 'R terminate',
    exit: 'R A terminate',
    org_config: 'R U',
    users_roles: 'R',
    audit_log: 'R',
    approval_delegation: 'C R U',
  },
  cxo: {
    profile: 'R',
    compensation: 'R',
    assignment_history: 'R',
    attendance: 'R',
    leave: 'R',
    hybrid_booking: 'R',
    journey_public: 'R',
    journey_sensitive: 'R',
    exit: 'R',
  },
  admin: {
    org_config: 'C R U D',
    users_roles: 'C R U D',
    audit_log: 'R',
  },
};

const codes: Record<string, Action> = {
  R: 'read',
  C: 'create',
  U: 'update',
  A: 'approve',
  D: 'delete',
};
const expectedActions = (cell: string | undefined): Set<Action> =>
  new Set(
    (cell ?? '')
      .split(' ')
      .filter(Boolean)
      .map((code) => codes[code] ?? (code as Action)),
  );

const ENTITY = '11111111-1111-4111-8111-111111111111';
const OTHER_ENTITY = '22222222-2222-4222-8222-222222222222';
const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MY_USER = 'abababab-abab-4bab-8bab-abababababab';
const REPORTEE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STRANGER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const team: ScopeResolver = {
  isInTeam: async (manager, subject) => manager === ME && subject === REPORTEE,
};
const authz = new AuthzService(team);

const actorWith = (role: Role, legalEntityId: string | null = ENTITY): Actor => ({
  userId: MY_USER,
  tenantId: 't',
  personId: ME,
  roles: [{ role, legalEntityId }],
});

const permissive = {
  beforeCutoff: true,
  confidential: false,
  decided: true,
  createdByUserId: MY_USER,
};

/** A record the role's scope covers: own for employees, a reportee for managers, same entity otherwise. */
function inScopeResource(role: Role, area: DataArea): Resource {
  const subjectPersonId = role === 'employee' ? ME : role === 'manager' ? REPORTEE : STRANGER;
  return {
    area,
    subjectPersonId,
    subjectUserId: area === 'approval_delegation' ? MY_USER : undefined,
    legalEntityId: ENTITY,
    attributes: permissive,
  };
}

describe('permissions table: every role, every area, every action', () => {
  const cases = roles.flatMap((role) =>
    dataAreas.flatMap((area) => actions.map((action) => [role, area, action] as const)),
  );

  it.each(cases)('%s %s %s', async (role, area, action) => {
    const expected = expectedActions(specTable[role][area]).has(action);
    const resource =
      role === 'manager' && area === 'approval_delegation'
        ? { area, subjectUserId: MY_USER }
        : inScopeResource(role, area);
    const decision = await authz.check(actorWith(role), action, resource);
    expect(decision.allowed).toBe(expected);
    expect(authz.can(actorWith(role), area, action)).toBe(expected);
  });
});

describe('scopes deny outside the role', () => {
  it('employee cannot read another person', async () => {
    const decision = await authz.check(actorWith('employee'), 'read', {
      area: 'profile',
      subjectPersonId: STRANGER,
    });
    expect(decision.allowed).toBe(false);
  });

  it('manager reads a reportee but not someone outside the team', async () => {
    const manager = actorWith('manager');
    expect(
      (await authz.check(manager, 'read', { area: 'leave', subjectPersonId: REPORTEE })).allowed,
    ).toBe(true);
    expect(
      (await authz.check(manager, 'read', { area: 'leave', subjectPersonId: STRANGER })).allowed,
    ).toBe(false);
  });

  it('manager role alone gives no team rights over the manager themself', async () => {
    const decision = await authz.check(actorWith('manager'), 'approve', {
      area: 'leave',
      subjectPersonId: ME,
    });
    expect(decision.allowed).toBe(false);
  });

  it('manager cannot see KYC, compensation or sensitive journey events of the team', async () => {
    const manager = actorWith('manager');
    for (const area of ['kyc', 'compensation', 'journey_sensitive'] as const) {
      const decision = await authz.check(manager, 'read', { area, subjectPersonId: REPORTEE });
      expect(decision.allowed, area).toBe(false);
    }
  });

  it('entity-scoped roles stop at their legal entity', async () => {
    const hr = actorWith('hr', ENTITY);
    const resource = { area: 'profile' as const, subjectPersonId: STRANGER };
    expect((await authz.check(hr, 'read', { ...resource, legalEntityId: ENTITY })).allowed).toBe(
      true,
    );
    expect(
      (await authz.check(hr, 'read', { ...resource, legalEntityId: OTHER_ENTITY })).allowed,
    ).toBe(false);
    expect((await authz.check(hr, 'read', resource)).allowed).toBe(false);
  });

  it('a grant for every entity covers any entity', async () => {
    const decision = await authz.check(actorWith('hr', null), 'read', {
      area: 'profile',
      subjectPersonId: STRANGER,
      legalEntityId: OTHER_ENTITY,
    });
    expect(decision.allowed).toBe(true);
  });

  it('admin sees configuration, not people data', async () => {
    const admin = actorWith('admin');
    for (const area of ['profile', 'kyc', 'compensation', 'leave', 'journey_public'] as const) {
      const decision = await authz.check(admin, 'read', {
        area,
        subjectPersonId: STRANGER,
        legalEntityId: ENTITY,
      });
      expect(decision.allowed, area).toBe(false);
    }
  });

  it('a user with no roles is denied everything', async () => {
    const nobody: Actor = { userId: MY_USER, tenantId: 't', personId: ME, roles: [] };
    expect(
      (await authz.check(nobody, 'read', { area: 'profile', subjectPersonId: ME })).allowed,
    ).toBe(false);
  });
});

describe('qualified cells', () => {
  it('KYC reads are masked; unmasking is a separate action for HR and HR head only', async () => {
    const own = await authz.check(actorWith('employee'), 'read', {
      area: 'kyc',
      subjectPersonId: ME,
    });
    expect(own.allowed && [...own.obligations]).toEqual(['mask']);
    const hr = await authz.check(actorWith('hr'), 'read', inScopeResource('hr', 'kyc'));
    expect(hr.allowed && [...hr.obligations]).toEqual(['mask']);
    expect(
      (await authz.check(actorWith('employee'), 'unmask', { area: 'kyc', subjectPersonId: ME }))
        .allowed,
    ).toBe(false);
  });

  it('employee profile updates go through a change request', async () => {
    const decision = await authz.check(actorWith('employee'), 'update', {
      area: 'profile',
      subjectPersonId: ME,
    });
    expect(decision.allowed && [...decision.obligations]).toEqual(['via_change_request']);
  });

  it('HR attendance and leave updates need a reason', async () => {
    for (const area of ['attendance', 'leave'] as const) {
      const decision = await authz.check(actorWith('hr'), 'update', inScopeResource('hr', area));
      expect(decision.allowed && [...decision.obligations], area).toEqual(['requires_reason']);
    }
  });

  it('CXO sees attendance, leave and hybrid as aggregates only', async () => {
    for (const area of ['attendance', 'leave', 'hybrid_booking'] as const) {
      const decision = await authz.check(actorWith('cxo'), 'read', inScopeResource('cxo', area));
      expect(decision.allowed && [...decision.obligations], area).toEqual(['aggregates_only']);
    }
  });

  it('a CXO who also manages someone sees that reportee in full', async () => {
    const cxoManager: Actor = {
      ...actorWith('cxo'),
      roles: [
        { role: 'cxo', legalEntityId: ENTITY },
        { role: 'manager', legalEntityId: ENTITY },
      ],
    };
    const decision = await authz.check(cxoManager, 'read', {
      area: 'leave',
      subjectPersonId: REPORTEE,
      legalEntityId: ENTITY,
    });
    expect(decision.allowed && [...decision.obligations]).toEqual([]);
  });

  it('hybrid bookings can be changed only before the cut-off', async () => {
    const resource = { area: 'hybrid_booking' as const, subjectPersonId: ME };
    const employee = actorWith('employee');
    expect(
      (await authz.check(employee, 'update', { ...resource, attributes: { beforeCutoff: true } }))
        .allowed,
    ).toBe(true);
    expect(
      (await authz.check(employee, 'update', { ...resource, attributes: { beforeCutoff: false } }))
        .allowed,
    ).toBe(false);
    expect((await authz.check(employee, 'update', resource)).allowed).toBe(false);
  });

  it('managers read only non-confidential team documents', async () => {
    const resource = { area: 'documents' as const, subjectPersonId: REPORTEE };
    const manager = actorWith('manager');
    expect(
      (await authz.check(manager, 'read', { ...resource, attributes: { confidential: false } }))
        .allowed,
    ).toBe(true);
    expect(
      (await authz.check(manager, 'read', { ...resource, attributes: { confidential: true } }))
        .allowed,
    ).toBe(false);
  });

  it('employees read their probation review only after the decision', async () => {
    const resource = { area: 'probation_review' as const, subjectPersonId: ME };
    const employee = actorWith('employee');
    expect(
      (await authz.check(employee, 'read', { ...resource, attributes: { decided: true } })).allowed,
    ).toBe(true);
    expect(
      (await authz.check(employee, 'read', { ...resource, attributes: { decided: false } }))
        .allowed,
    ).toBe(false);
  });

  it('HR reads only its own audit log entries; HR head reads all', async () => {
    const resource = { area: 'audit_log' as const, legalEntityId: ENTITY };
    const mine = { ...resource, attributes: { createdByUserId: MY_USER } };
    const theirs = { ...resource, attributes: { createdByUserId: STRANGER } };
    expect((await authz.check(actorWith('hr'), 'read', mine)).allowed).toBe(true);
    expect((await authz.check(actorWith('hr'), 'read', theirs)).allowed).toBe(false);
    expect((await authz.check(actorWith('hr_head'), 'read', theirs)).allowed).toBe(true);
  });

  it('assert throws 403 when denied', async () => {
    await expect(
      authz.assert(actorWith('employee'), 'read', { area: 'profile', subjectPersonId: STRANGER }),
    ).rejects.toThrow('Forbidden');
  });
});
