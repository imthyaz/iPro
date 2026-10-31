import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { RoleGrant } from '@ipro/shared';
import type { Actor } from '../context/request-context.js';
import {
  permissions,
  type Action,
  type Condition,
  type DataArea,
  type Grant,
  type Obligation,
} from './permissions.js';
import { SCOPE_RESOLVER, type ScopeResolver } from './scope-resolver.js';

/** What is being accessed. Fields that don't apply to an area are left out. */
export interface Resource {
  area: DataArea;
  /** The person the data is about (people data). */
  subjectPersonId?: string | null;
  /** The user the record belongs to (sign-in data such as delegations). */
  subjectUserId?: string | null;
  legalEntityId?: string | null;
  /** Record state that conditions read. */
  attributes?: {
    beforeCutoff?: boolean;
    confidential?: boolean;
    decided?: boolean;
    createdByUserId?: string | null;
  };
  /** Date the team relationship is checked at (defaults to now). */
  asOf?: Date;
}

export type Decision = { allowed: true; obligations: ReadonlySet<Obligation> } | { allowed: false };

/** The only place access is decided. Denies by default. */
@Injectable()
export class AuthzService {
  constructor(@Inject(SCOPE_RESOLVER) private readonly scopes: ScopeResolver) {}

  /**
   * Coarse check for routes: does any of the actor's roles grant this action on this area at all?
   * Services still call `check`/`assert` with the actual record.
   */
  can(actor: Actor, area: DataArea, action: Action): boolean {
    return actor.roles.some((grant) =>
      permissions[grant.role].some((rule) => rule.area === area && rule.actions.includes(action)),
    );
  }

  async check(actor: Actor, action: Action, resource: Resource): Promise<Decision> {
    const matching: Grant[] = [];
    for (const roleGrant of actor.roles) {
      for (const rule of permissions[roleGrant.role]) {
        if (rule.area !== resource.area || !rule.actions.includes(action)) continue;
        if (!this.conditionsHold(rule.conditions ?? [], actor, resource)) continue;
        if (!(await this.inScope(rule, roleGrant, actor, resource))) continue;
        matching.push(rule);
      }
    }
    if (matching.length === 0) return { allowed: false };
    // Several grants may apply (e.g. CXO aggregates and a manager's own team); the least restrictive wins.
    const [first, ...rest] = matching.map((rule) => new Set(rule.obligations ?? []));
    const obligations = new Set([...first!].filter((o) => rest.every((set) => set.has(o))));
    return { allowed: true, obligations };
  }

  /** `check` that throws 403 when denied; returns the obligations the caller must honour. */
  async assert(actor: Actor, action: Action, resource: Resource): Promise<ReadonlySet<Obligation>> {
    const decision = await this.check(actor, action, resource);
    if (!decision.allowed) throw new ForbiddenException();
    return decision.obligations;
  }

  private async inScope(
    rule: Grant,
    roleGrant: RoleGrant,
    actor: Actor,
    resource: Resource,
  ): Promise<boolean> {
    switch (rule.scope) {
      case 'own':
        return isOwn(actor, resource);
      case 'team':
        if (!actor.personId || !resource.subjectPersonId) return false;
        if (actor.personId === resource.subjectPersonId) return false;
        return this.scopes.isInTeam(
          actor.personId,
          resource.subjectPersonId,
          resource.asOf ?? new Date(),
        );
      case 'entity':
        return (
          roleGrant.legalEntityId === null || roleGrant.legalEntityId === resource.legalEntityId
        );
    }
  }

  private conditionsHold(conditions: readonly Condition[], actor: Actor, resource: Resource) {
    const attributes = resource.attributes ?? {};
    return conditions.every((condition) => {
      switch (condition) {
        case 'before_cutoff':
          return attributes.beforeCutoff === true;
        case 'non_confidential':
          return attributes.confidential === false;
        case 'after_decision':
          return attributes.decided === true;
        case 'own_actions':
          return attributes.createdByUserId === actor.userId;
      }
    });
  }
}

function isOwn(actor: Actor, resource: Resource): boolean {
  if (resource.subjectPersonId) return actor.personId === resource.subjectPersonId;
  if (resource.subjectUserId) return actor.userId === resource.subjectUserId;
  return false;
}
