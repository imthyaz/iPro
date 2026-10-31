import { describe, expect, it } from 'vitest';
import { diffGrants, identityFromClaims, rolesFromGroups, SignInRejected } from './claims.js';

// Synthetic claims only.
const TENANT = 'entra-tenant';
const claims = {
  tid: TENANT,
  oid: 'object-1',
  name: 'Test User',
  preferred_username: 'test.user@example.test',
  groups: ['g-staff', 'g-managers'],
};

describe('identityFromClaims', () => {
  it('reads the identity and groups', () => {
    expect(identityFromClaims(claims, TENANT)).toEqual({
      objectId: 'object-1',
      email: 'test.user@example.test',
      displayName: 'Test User',
      groups: ['g-staff', 'g-managers'],
    });
  });

  it('rejects tokens from another Entra tenant', () => {
    expect(() => identityFromClaims({ ...claims, tid: 'other' }, TENANT)).toThrow(SignInRejected);
  });

  it('rejects tokens without an object id or email', () => {
    expect(() => identityFromClaims({ ...claims, oid: undefined }, TENANT)).toThrow(SignInRejected);
    expect(() => identityFromClaims({ ...claims, preferred_username: 'no-email' }, TENANT)).toThrow(
      SignInRejected,
    );
  });

  it('rejects group overage instead of silently dropping roles', () => {
    expect(() =>
      identityFromClaims(
        { ...claims, groups: undefined, _claim_names: { groups: 'src1' } },
        TENANT,
      ),
    ).toThrow(/Too many groups/);
  });
});

describe('rolesFromGroups', () => {
  const mappings = [
    { entraGroupId: 'g-staff', role: 'employee' as const, legalEntityId: null },
    { entraGroupId: 'g-managers', role: 'manager' as const, legalEntityId: null },
    { entraGroupId: 'g-staff-2', role: 'employee' as const, legalEntityId: null },
    { entraGroupId: 'g-hr', role: 'hr' as const, legalEntityId: 'le-1' },
  ];

  it('maps groups to roles without duplicates', () => {
    expect(rolesFromGroups(['g-staff', 'g-staff-2', 'g-managers'], mappings)).toEqual([
      { role: 'employee', legalEntityId: null },
      { role: 'manager', legalEntityId: null },
    ]);
  });

  it('gives no roles for unmapped groups', () => {
    expect(rolesFromGroups(['g-unknown'], mappings)).toEqual([]);
  });
});

describe('diffGrants', () => {
  it('adds new grants and retires removed ones', () => {
    const current = [
      { id: 'r1', role: 'employee' as const, legalEntityId: null },
      { id: 'r2', role: 'hr' as const, legalEntityId: 'le-1' },
    ];
    const wanted = [
      { role: 'employee' as const, legalEntityId: null },
      { role: 'manager' as const, legalEntityId: null },
    ];
    expect(diffGrants(current, wanted)).toEqual({
      add: [{ role: 'manager', legalEntityId: null }],
      retireIds: ['r2'],
    });
  });
});
