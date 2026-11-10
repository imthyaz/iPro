import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { addDays, businessDate } from '../common/effective-dating.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import { engagements } from '../people/people.schema.js';
import { checklistRuns, checklistTasks } from '../workflow/checklists.schema.js';
import {
  managerUserOfPerson,
  notify,
  personName,
  roleHolders,
  userOfPerson,
} from '../workflow/lookups.js';
import { anniversaryYears, ordinalYears } from './delivery-rules.js';

const longDate = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`));

/**
 * Date-driven notices (spec: Notifications; decision #87), daily at 09:00 IST: joining in 7 days and
 * tomorrow (HR, manager and the people with the joiner's onboarding tasks, which include IT); last
 * working day in 7 days (the person, manager, HR and exit task owners); work anniversaries (the
 * person and their manager). Each is sent once, so a second run the same day sends nothing new.
 */
@Injectable()
export class MilestonesService {
  constructor(@Inject(TenantDb) private readonly db: TenantDb) {}

  async run(today = businessDate(new Date())): Promise<{ notices: number }> {
    return this.db.tx(async (tx) => {
      let notices = 0;
      notices += await this.joining(tx, today, 7);
      notices += await this.joining(tx, today, 1);
      notices += await this.lastDays(tx, today);
      notices += await this.anniversaries(tx, today);
      return { notices };
    });
  }

  private async joining(tx: Tx, today: string, days: 7 | 1): Promise<number> {
    const day = addDays(today, days);
    const joiners = await tx
      .select({
        id: engagements.id,
        personId: engagements.personId,
        legalEntityId: engagements.legalEntityId,
      })
      .from(engagements)
      .where(
        and(
          inArray(engagements.status, ['offered', 'pre_joining']),
          eq(engagements.joiningDate, day),
        ),
      );
    for (const j of joiners) {
      const name = await personName(tx, j.personId);
      const manager = await managerUserOfPerson(tx, j.personId, day);
      await notify(
        tx,
        [
          ...(await roleHolders(tx, 'hr', j.legalEntityId)),
          ...(manager ? [manager] : []),
          ...(await this.taskOwners(tx, j.id)),
        ],
        'joining_soon',
        days === 1 ? `${name} joins tomorrow` : `${name} joins on ${longDate(day)}`,
        `/people/${j.personId}`,
        { dedupeKey: `joining:${j.id}:${day}:${days}` },
      );
    }
    return joiners.length;
  }

  private async lastDays(tx: Tx, today: string): Promise<number> {
    const day = addDays(today, 7);
    const leavers = await tx
      .select({
        id: engagements.id,
        personId: engagements.personId,
        legalEntityId: engagements.legalEntityId,
      })
      .from(engagements)
      .where(
        and(
          eq(engagements.status, 'on_notice'),
          isNotNull(engagements.lastWorkingDate),
          eq(engagements.lastWorkingDate, day),
        ),
      );
    for (const l of leavers) {
      const key = `last-day:${l.id}:${day}`;
      const self = await userOfPerson(tx, l.personId);
      if (self) {
        await notify(
          tx,
          [self],
          'last_day_soon',
          `Your last working day is ${longDate(day)}`,
          '/resign',
          {
            dedupeKey: key,
          },
        );
      }
      const name = await personName(tx, l.personId);
      const manager = await managerUserOfPerson(tx, l.personId, today);
      await notify(
        tx,
        [
          ...(await roleHolders(tx, 'hr', l.legalEntityId)),
          ...(manager ? [manager] : []),
          ...(await this.taskOwners(tx, l.id)),
        ].filter((u) => u !== self),
        'last_day_soon',
        `${name}’s last working day is ${longDate(day)}`,
        `/people/${l.personId}`,
        { dedupeKey: key },
      );
    }
    return leavers.length;
  }

  private async anniversaries(tx: Tx, today: string): Promise<number> {
    const people = await tx
      .select({
        id: engagements.id,
        personId: engagements.personId,
        joiningDate: engagements.joiningDate,
      })
      .from(engagements)
      .where(inArray(engagements.status, ['active', 'on_notice']));
    let count = 0;
    for (const p of people) {
      const years = anniversaryYears(p.joiningDate, today);
      if (!years) continue;
      count += 1;
      const key = `anniversary:${p.id}:${today.slice(0, 4)}`;
      const self = await userOfPerson(tx, p.personId);
      if (self) {
        await notify(
          tx,
          [self],
          'work_anniversary',
          `Happy work anniversary: ${ordinalYears(years)} today`,
          '/journey',
          { dedupeKey: key },
        );
      }
      const manager = await managerUserOfPerson(tx, p.personId, today);
      if (manager && manager !== self) {
        await notify(
          tx,
          [manager],
          'work_anniversary',
          `${await personName(tx, p.personId)} completes ${ordinalYears(years)} today`,
          `/people/${p.personId}`,
          { dedupeKey: key },
        );
      }
    }
    return count;
  }

  /** People named on this person's open checklist tasks (IT, finance and other designated owners). */
  private async taskOwners(tx: Tx, engagementId: string): Promise<string[]> {
    const rows = await tx
      .selectDistinct({ userId: checklistTasks.assigneeUserId })
      .from(checklistTasks)
      .innerJoin(checklistRuns, eq(checklistRuns.id, checklistTasks.runId))
      .where(
        and(
          eq(checklistRuns.engagementId, engagementId),
          eq(checklistRuns.status, 'open'),
          eq(checklistTasks.status, 'open'),
          eq(checklistTasks.ownerKind, 'user'),
          isNotNull(checklistTasks.assigneeUserId),
        ),
      );
    return rows.map((r) => r.userId!);
  }
}
