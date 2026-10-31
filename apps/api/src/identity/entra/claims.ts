import type { RoleGrant } from '@ipro/shared';

export interface EntraIdentity {
  objectId: string;
  email: string;
  displayName: string;
  groups: string[];
}

export class SignInRejected extends Error {}

/**
 * Reads the ID token claims Entra issues. The app registration must emit the `groups` claim, limited to
 * groups assigned to the application, so the list never overflows into a Graph lookup.
 */
export function identityFromClaims(
  claims: Record<string, unknown>,
  expectedTenantId: string,
): EntraIdentity {
  if (claims.tid !== expectedTenantId)
    throw new SignInRejected('Token is from another Entra tenant');
  const objectId = claims.oid;
  if (typeof objectId !== 'string' || !objectId) throw new SignInRejected('Token has no oid claim');

  const names = claims._claim_names;
  if (names && typeof names === 'object' && 'groups' in names) {
    throw new SignInRejected(
      'Too many groups for the token; limit the groups claim to groups assigned to the iPro app',
    );
  }

  const email = [claims.email, claims.preferred_username].find(
    (value): value is string => typeof value === 'string' && value.includes('@'),
  );
  if (!email) throw new SignInRejected('Token has no email');

  const groups = Array.isArray(claims.groups)
    ? claims.groups.filter((group): group is string => typeof group === 'string')
    : [];
  const displayName = typeof claims.name === 'string' && claims.name ? claims.name : email;
  return { objectId, email, displayName, groups };
}

export interface GroupRoleMapping {
  entraGroupId: string;
  role: RoleGrant['role'];
  legalEntityId: string | null;
}

/** Roles from the user's Entra groups, without duplicates. No mapped group means no iPro access. */
export function rolesFromGroups(groups: string[], mappings: GroupRoleMapping[]): RoleGrant[] {
  const memberOf = new Set(groups);
  const grants = new Map<string, RoleGrant>();
  for (const mapping of mappings) {
    if (!memberOf.has(mapping.entraGroupId)) continue;
    grants.set(`${mapping.role}:${mapping.legalEntityId ?? '*'}`, {
      role: mapping.role,
      legalEntityId: mapping.legalEntityId,
    });
  }
  return [...grants.values()];
}

/** Which role rows to add and which to retire, so a re-sync touches only what changed. */
export function diffGrants(
  current: (RoleGrant & { id: string })[],
  wanted: RoleGrant[],
): { add: RoleGrant[]; retireIds: string[] } {
  const key = (grant: RoleGrant) => `${grant.role}:${grant.legalEntityId ?? '*'}`;
  const wantedKeys = new Set(wanted.map(key));
  const currentKeys = new Set(current.map(key));
  return {
    add: wanted.filter((grant) => !currentKeys.has(key(grant))),
    retireIds: current.filter((grant) => !wantedKeys.has(key(grant))).map((grant) => grant.id),
  };
}
