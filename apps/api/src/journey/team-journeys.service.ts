import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { and, asc, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import type { TeamJourneyPerson, TeamJourneysView } from '@ipro/shared';
import { AuthzService } from '../authz/authz.service.js';
import { addDays, businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import { departmentVersions, designations } from '../org/org.schema.js';
import { assignments, engagements, persons } from '../people/people.schema.js';
import { journalEvents } from './journey.schema.js';
import { visibleEvents } from './timeline.service.js';

type EngagementRow = typeof engagements.$inferSelect;
type EventRow = typeof journalEvents.$inferSelect;

const VIEWERS = new Set(['manager', 'hr', 'hr_head', 'cxo']);
const MAX_DAYS = 3660;
const between = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Team journeys (slice 10b; M6 for managers, H11 for HR and CXO; decision #85): everyone in view,
 * side by side, with the events each viewer may see and what grouping needs. Built for 150 people
 * over three years (done-when #3): a handful of set queries, no query per person.
 */
@Injectable()
export class TeamJourneysService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
  ) {}

  async team(
    query: { scope: 'team' | 'all'; from: string; to: string; exited: 'true' | 'false' },
    now = new Date(),
  ): Promise<TeamJourneysView> {
    const actor = requireContext().actor!;
    if (!actor.roles.some((r) => VIEWERS.has(r.role))) throw new ForbiddenException();
    const { from, to } = query;
    if (to < from || between(from, to) > MAX_DAYS) {
      throw new BadRequestException({
        message: 'Choose a range that ends after it starts, up to 10 years',
      });
    }
    const today = businessDate(now);
    return this.db.tx(async (tx) => {
      const statuses: EngagementRow['status'][] =
        query.exited === 'true' ? ['active', 'on_notice', 'exited'] : ['active', 'on_notice'];
      const candidates = await tx
        .select()
        .from(engagements)
        .where(
          and(
            inArray(engagements.status, statuses),
            lte(engagements.joiningDate, to),
            or(isNull(engagements.lastWorkingDate), gte(engagements.lastWorkingDate, from)),
          ),
        )
        .orderBy(asc(engagements.joiningDate));
      const ids = candidates.map((e) => e.id);
      const history = ids.length
        ? await tx
            .select()
            .from(assignments)
            .where(inArray(assignments.engagementId, ids))
            .orderBy(asc(assignments.effectiveFrom))
        : [];
      // Each engagement's assignment as of today, or its last day for someone who left.
      const asOf = (e: EngagementRow) =>
        e.lastWorkingDate && e.lastWorkingDate < today ? e.lastWorkingDate : today;
      const current = new Map(
        candidates.map((e) => {
          const on = asOf(e);
          const row = history
            .filter((a) => a.engagementId === e.id && a.effectiveFrom <= on)
            .at(-1);
          return [e.id, row];
        }),
      );

      // Who is in view.
      let inView: EngagementRow[];
      if (query.scope === 'team') {
        const mine = new Set(
          candidates.filter((e) => e.personId === actor.personId).map((e) => e.id),
        );
        const reportsTo = new Map<string, string[]>();
        for (const e of candidates) {
          const manager = current.get(e.id)?.managerEngagementId;
          if (manager) reportsTo.set(manager, [...(reportsTo.get(manager) ?? []), e.id]);
        }
        const team = new Set<string>();
        const queue = [...mine];
        while (queue.length) {
          for (const report of reportsTo.get(queue.shift()!) ?? []) {
            if (!team.has(report) && !mine.has(report)) {
              team.add(report);
              queue.push(report);
            }
          }
        }
        inView = candidates.filter((e) => team.has(e.id));
      } else {
        inView = [];
        for (const e of candidates) {
          if (e.personId === actor.personId) continue;
          const decision = await this.authz.check(actor, 'read', {
            area: 'journey_public',
            subjectPersonId: e.personId,
            legalEntityId: e.legalEntityId,
          });
          if (decision.allowed) inView.push(e);
        }
      }

      const personIds = [...new Set(inView.map((e) => e.personId))];
      const managerIds = [
        ...new Set(
          inView.map((e) => current.get(e.id)?.managerEngagementId).filter((x): x is string => !!x),
        ),
      ];
      const managerEngagements = managerIds.length
        ? await tx.select().from(engagements).where(inArray(engagements.id, managerIds))
        : [];
      const allPersonIds = [
        ...new Set([...personIds, ...managerEngagements.map((m) => m.personId)]),
      ];
      const people = allPersonIds.length
        ? await tx.select().from(persons).where(inArray(persons.id, allPersonIds))
        : [];
      const nameOf = new Map(people.map((p) => [p.id, p.preferredName ?? p.legalName]));
      const designationIds = [...new Set(history.map((a) => a.designationId))];
      const titles = designationIds.length
        ? await tx.select().from(designations).where(inArray(designations.id, designationIds))
        : [];
      const departmentIds = [...new Set(history.map((a) => a.departmentId))];
      const versions = departmentIds.length
        ? await tx
            .select()
            .from(departmentVersions)
            .where(inArray(departmentVersions.departmentId, departmentIds))
        : [];
      const departmentOn = (id: string, on: string) =>
        versions.find(
          (v) =>
            v.departmentId === id &&
            v.effectiveFrom <= on &&
            (!v.effectiveTo || v.effectiveTo >= on),
        )?.name ?? null;

      // Every event for these people (planned ones need theirs resolved), then the range.
      const rows = personIds.length
        ? await tx
            .select()
            .from(journalEvents)
            .where(inArray(journalEvents.personId, personIds))
            .orderBy(asc(journalEvents.occurredOn), asc(journalEvents.createdAt))
        : [];
      const byPerson = new Map<string, EventRow[]>();
      for (const r of rows) byPerson.set(r.personId, [...(byPerson.get(r.personId) ?? []), r]);

      const out: TeamJourneyPerson[] = [];
      for (const e of inView) {
        const sensitive = (
          await this.authz.check(actor, 'read', {
            area: 'journey_sensitive',
            subjectPersonId: e.personId,
            legalEntityId: e.legalEntityId,
          })
        ).allowed;
        const assignment = current.get(e.id);
        const designation = titles.find((t) => t.id === assignment?.designationId);
        const manager = managerEngagements.find((m) => m.id === assignment?.managerEngagementId);
        const events = visibleEvents(byPerson.get(e.personId) ?? [], sensitive, today)
          .filter((x) => x.date >= from && x.date <= to)
          .map(({ id, type, category, title, date, upcoming }) => ({
            id,
            type,
            category,
            title,
            date,
            upcoming,
          }));
        out.push({
          personId: e.personId,
          name: nameOf.get(e.personId) ?? '',
          employeeCode: e.employeeCode,
          designation: designation?.title ?? null,
          band: designation?.designationBand ?? null,
          department: assignment ? departmentOn(assignment.departmentId, asOf(e)) : null,
          manager: manager
            ? { personId: manager.personId, name: nameOf.get(manager.personId) ?? '' }
            : null,
          status: e.status as TeamJourneyPerson['status'],
          onProbation: e.probationEndDate !== null && e.confirmationDate === null,
          joiningDate: e.joiningDate,
          lastWorkingDate: e.lastWorkingDate,
          tenureYears: Math.floor(between(e.joiningDate, asOf(e)) / 365.25),
          events,
        });
      }

      const yearAgo = addDays(today, -365);
      const working = out.filter((x) => x.status !== 'exited');
      const inMonth = addDays(today, 30);
      const probationDue = inView.filter(
        (e) =>
          e.status !== 'exited' &&
          e.confirmationDate === null &&
          e.probationEndDate !== null &&
          e.probationEndDate >= today &&
          e.probationEndDate <= inMonth,
      ).length;
      return {
        today,
        from,
        to,
        people: out,
        tiles: {
          headcount: working.length,
          exitedInView: out.length - working.length,
          probationDue30: probationDue,
          onNotice: out.filter((x) => x.status === 'on_notice').length,
          designationChanges12m: out.reduce(
            (n, x) =>
              n +
              x.events.filter(
                (ev) => ev.category === 'career' && ev.date >= yearAgo && !ev.upcoming,
              ).length,
            0,
          ),
          joiners12m: working.filter((x) => x.joiningDate >= yearAgo && x.joiningDate <= today)
            .length,
        },
      };
    });
  }
}
