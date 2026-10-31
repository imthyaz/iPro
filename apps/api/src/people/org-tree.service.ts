import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { OrgTree } from '@ipro/shared';
import { AuthzService } from '../authz/authz.service.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import { businessUnitVersions, departmentVersions, designations } from '../org/org.schema.js';
import { inForce } from './people.queries.js';
import { assignments, engagements, persons } from './people.schema.js';

/**
 * The org tree as of a date (screen H10), built only from rows in force that day: assignments for the
 * reporting tree, department and business unit versions for the department tree.
 */
@Injectable()
export class OrgTreeService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
  ) {}

  async asOf(asOf: string): Promise<OrgTree> {
    const actor = requireContext().actor!;
    const { people, departments } = await this.db.tx(async (tx) => {
      const managerEngagement = alias(engagements, 'manager_engagement');
      const people = await tx
        .select({
          personId: persons.id,
          legalName: persons.legalName,
          preferredName: persons.preferredName,
          employeeCode: engagements.employeeCode,
          engagementType: engagements.type,
          legalEntityId: engagements.legalEntityId,
          designationTitle: designations.title,
          departmentId: assignments.departmentId,
          departmentName: departmentVersions.name,
          managerPersonId: managerEngagement.personId,
        })
        .from(assignments)
        .innerJoin(engagements, eq(engagements.id, assignments.engagementId))
        .innerJoin(persons, eq(persons.id, engagements.personId))
        .innerJoin(designations, eq(designations.id, assignments.designationId))
        .leftJoin(
          departmentVersions,
          and(
            eq(departmentVersions.departmentId, assignments.departmentId),
            inForce(departmentVersions.effectiveFrom, departmentVersions.effectiveTo, asOf),
          ),
        )
        .leftJoin(managerEngagement, eq(managerEngagement.id, assignments.managerEngagementId))
        .where(inForce(assignments.effectiveFrom, assignments.effectiveTo, asOf));

      const departments = await tx
        .select({
          departmentId: departmentVersions.departmentId,
          name: departmentVersions.name,
          parentDepartmentId: departmentVersions.parentDepartmentId,
          businessUnitId: departmentVersions.businessUnitId,
          businessUnitName: businessUnitVersions.name,
        })
        .from(departmentVersions)
        .leftJoin(
          businessUnitVersions,
          and(
            eq(businessUnitVersions.businessUnitId, departmentVersions.businessUnitId),
            inForce(businessUnitVersions.effectiveFrom, businessUnitVersions.effectiveTo, asOf),
          ),
        )
        .where(inForce(departmentVersions.effectiveFrom, departmentVersions.effectiveTo, asOf));
      return { people, departments };
    });

    // Only the people the actor may see; a manager sees their own team's subtree.
    const visible = [];
    for (const person of people) {
      const decision = await this.authz.check(actor, 'read', {
        area: 'assignment_history',
        subjectPersonId: person.personId,
        legalEntityId: person.legalEntityId,
        asOf,
      });
      if (decision.allowed) visible.push(person);
    }
    const visibleIds = new Set(visible.map((p) => p.personId));
    const headcount = new Map<string, number>();
    for (const person of visible) {
      headcount.set(person.departmentId, (headcount.get(person.departmentId) ?? 0) + 1);
    }

    return {
      asOf,
      people: visible
        .map((p) => ({
          personId: p.personId,
          name: p.preferredName ?? p.legalName,
          employeeCode: p.employeeCode,
          engagementType: p.engagementType,
          designation: p.designationTitle,
          departmentId: p.departmentId,
          departmentName: p.departmentName ?? '',
          // A manager outside the actor's view becomes a root, so the tree never leaks who they are.
          managerPersonId:
            p.managerPersonId && visibleIds.has(p.managerPersonId) ? p.managerPersonId : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      departments: departments
        .map((d) => ({
          departmentId: d.departmentId,
          name: d.name,
          parentDepartmentId: d.parentDepartmentId,
          businessUnitId: d.businessUnitId,
          businessUnitName: d.businessUnitName ?? '',
          headcount: headcount.get(d.departmentId) ?? 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
}
