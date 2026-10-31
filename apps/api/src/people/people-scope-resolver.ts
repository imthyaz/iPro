import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { ScopeResolver } from '../authz/scope-resolver.js';
import { TenantDb } from '../db/tenant-db.js';

/** Reporting chains longer than this are treated as data errors, not followed. */
const MAX_DEPTH = 20;

/**
 * Team scope from assignments in force on a date: walks the subject's solid-line manager chain upward
 * (decision #18; dotted-line managers grant nothing).
 */
@Injectable()
export class PeopleScopeResolver implements ScopeResolver {
  constructor(@Inject(TenantDb) private readonly db: TenantDb) {}

  async isInTeam(managerPersonId: string, subjectPersonId: string, day: string): Promise<boolean> {
    const result = await this.db.tx((tx) =>
      tx.execute<{ in_team: boolean }>(sql`
        with recursive chain(engagement_id, depth) as (
          select a.manager_engagement_id, 1
          from assignment a
          join engagement e on e.id = a.engagement_id
          where e.person_id = ${subjectPersonId}
            and a.manager_engagement_id is not null
            and a.effective_from <= ${day} and (a.effective_to is null or a.effective_to >= ${day})
          union
          select a.manager_engagement_id, c.depth + 1
          from chain c
          join assignment a on a.engagement_id = c.engagement_id
          where a.manager_engagement_id is not null
            and a.effective_from <= ${day} and (a.effective_to is null or a.effective_to >= ${day})
            and c.depth < ${MAX_DEPTH}
        )
        select exists (
          select 1 from chain c join engagement e on e.id = c.engagement_id
          where e.person_id = ${managerPersonId}
        ) as in_team
      `),
    );
    return result.rows[0]?.in_team === true;
  }
}
