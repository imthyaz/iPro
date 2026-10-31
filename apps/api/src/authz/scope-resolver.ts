import { Injectable } from '@nestjs/common';

/** Org facts authz needs but doesn't own. The people module provides the real one (slice 2). */
export interface ScopeResolver {
  /**
   * True when `subjectPersonId` is a direct or indirect solid-line reportee of `managerPersonId` on
   * `asOf` (an ISO business date).
   */
  isInTeam(managerPersonId: string, subjectPersonId: string, asOf: string): Promise<boolean>;
}

export const SCOPE_RESOLVER = Symbol('SCOPE_RESOLVER');

/** Until reporting lines exist, nobody has a team: team-scoped grants deny. */
@Injectable()
export class NoTeamScopeResolver implements ScopeResolver {
  async isInTeam(): Promise<boolean> {
    return false;
  }
}
