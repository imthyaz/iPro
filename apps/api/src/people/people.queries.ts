import { and, eq, gte, ilike, inArray, isNull, lte, or, type SQL } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';
import type { PersonSummary } from '@ipro/shared';
import type { Tx } from '../db/tenant-context.js';
import { departmentVersions, designations, locationVersions } from '../org/org.schema.js';
import { assignments, engagements, persons } from './people.schema.js';

/** Rows of a dated table in force on `asOf` (inclusive end dates). */
export function inForce(from: PgColumn, to: PgColumn, asOf: string): SQL {
  return and(lte(from, asOf), or(isNull(to), gte(to, asOf)))!;
}

const LIVE = new Set(['offered', 'pre_joining', 'active', 'on_notice']);

export interface SummaryFilter {
  personIds?: string[];
  q?: string;
  departmentId?: string;
  locationId?: string;
  status?: PersonSummary['status'];
}

/**
 * One summary per person, as of a date: their live engagement (or latest one) and the assignment,
 * department and location versions in force that day.
 */
export async function personSummaries(
  tx: Tx,
  asOf: string,
  filter: SummaryFilter = {},
): Promise<PersonSummary[]> {
  const managerEngagement = alias(engagements, 'manager_engagement');
  const managerPerson = alias(persons, 'manager_person');
  const conditions: SQL[] = [isNull(persons.deletedAt)];
  if (filter.personIds) conditions.push(inArray(persons.id, filter.personIds));
  if (filter.q) {
    const like = `%${filter.q.replace(/[%_\\]/g, '\\$&')}%`;
    conditions.push(
      or(
        ilike(persons.legalName, like),
        ilike(persons.preferredName, like),
        ilike(engagements.employeeCode, like),
        ilike(engagements.workEmail, like),
      )!,
    );
  }

  const rows = await tx
    .select({
      personId: persons.id,
      legalName: persons.legalName,
      preferredName: persons.preferredName,
      engagement: engagements,
      assignment: assignments,
      designationTitle: designations.title,
      departmentName: departmentVersions.name,
      locationName: locationVersions.name,
      managerPersonId: managerPerson.id,
      managerName: managerPerson.legalName,
      managerPreferredName: managerPerson.preferredName,
    })
    .from(engagements)
    .innerJoin(persons, eq(persons.id, engagements.personId))
    .leftJoin(
      assignments,
      and(
        eq(assignments.engagementId, engagements.id),
        inForce(assignments.effectiveFrom, assignments.effectiveTo, asOf),
      ),
    )
    .leftJoin(designations, eq(designations.id, assignments.designationId))
    .leftJoin(
      departmentVersions,
      and(
        eq(departmentVersions.departmentId, assignments.departmentId),
        inForce(departmentVersions.effectiveFrom, departmentVersions.effectiveTo, asOf),
      ),
    )
    .leftJoin(
      locationVersions,
      and(
        eq(locationVersions.locationId, assignments.locationId),
        inForce(locationVersions.effectiveFrom, locationVersions.effectiveTo, asOf),
      ),
    )
    .leftJoin(managerEngagement, eq(managerEngagement.id, assignments.managerEngagementId))
    .leftJoin(managerPerson, eq(managerPerson.id, managerEngagement.personId))
    .where(and(...conditions));

  // Pick one engagement per person: a live one first, then the most recent.
  const byPerson = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const current = byPerson.get(row.personId);
    const rank = (r: (typeof rows)[number]) =>
      [LIVE.has(r.engagement.status) ? 1 : 0, r.engagement.joiningDate] as const;
    if (!current || compareRank(rank(row), rank(current)) > 0) byPerson.set(row.personId, row);
  }

  return [...byPerson.values()]
    .filter((row) => !filter.status || row.engagement.status === filter.status)
    .filter((row) => !filter.departmentId || row.assignment?.departmentId === filter.departmentId)
    .filter((row) => !filter.locationId || row.assignment?.locationId === filter.locationId)
    .map((row): PersonSummary => ({
      personId: row.personId,
      legalName: row.legalName,
      preferredName: row.preferredName,
      employeeCode: row.engagement.employeeCode,
      engagementId: row.engagement.id,
      engagementType: row.engagement.type,
      status: row.engagement.status,
      joiningDate: row.engagement.joiningDate,
      legalEntityId: row.engagement.legalEntityId,
      workEmail: row.engagement.workEmail,
      designation: row.assignment
        ? { id: row.assignment.designationId, title: row.designationTitle ?? '' }
        : null,
      department: row.assignment
        ? { id: row.assignment.departmentId, name: row.departmentName ?? '' }
        : null,
      location: row.assignment
        ? { id: row.assignment.locationId, name: row.locationName ?? '' }
        : null,
      manager:
        row.assignment?.managerEngagementId && row.managerPersonId
          ? {
              engagementId: row.assignment.managerEngagementId,
              personId: row.managerPersonId,
              name: row.managerPreferredName ?? row.managerName ?? '',
            }
          : null,
      bucket: row.assignment?.bucket ?? null,
    }))
    .sort((a, b) => (a.preferredName ?? a.legalName).localeCompare(b.preferredName ?? b.legalName));
}

function compareRank(a: readonly [number, string], b: readonly [number, string]): number {
  return a[0] - b[0] || a[1].localeCompare(b[1]);
}
