// Synthetic people for dev, linked to the dev sign-in users by work email. Never real employees.
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';
import { SEED_ORG } from './seed-org.js';
import type { Tx } from './tenant-context.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const designation = {
  associate: id(1601),
  engineer: id(1602),
  senior: id(1603),
  lead: id(1604),
  manager: id(1605),
  hr: id(1606),
};
const gradeOf: Record<string, string> = {
  [designation.associate]: id(1501),
  [designation.engineer]: id(1502),
  [designation.senior]: id(1503),
  [designation.lead]: id(1504),
  [designation.manager]: id(1505),
  [designation.hr]: id(1502),
};

interface SeedPerson {
  n: number;
  name: string;
  workEmail: string | null;
  designationId: string;
  departmentId: string;
  managerN: number | null;
  joiningDate: string;
  type?: 'permanent' | 'retainer';
}

/** n → person id(2000+n), engagement id(3000+n), assignment id(4000+n). Managers before reportees. */
const people: SeedPerson[] = [
  {
    n: 1,
    name: 'Dev CXO',
    workEmail: 'cxo@dev.ipro.test',
    designationId: designation.manager,
    departmentId: SEED_ORG.engineering,
    managerN: null,
    joiningDate: '2023-04-03',
  },
  {
    n: 2,
    name: 'Dev Manager',
    workEmail: 'manager@dev.ipro.test',
    designationId: designation.manager,
    departmentId: SEED_ORG.engineering,
    managerN: 1,
    joiningDate: '2023-06-01',
  },
  {
    n: 3,
    name: 'Dev Manager Two',
    workEmail: 'manager2@dev.ipro.test',
    designationId: designation.lead,
    departmentId: SEED_ORG.quality,
    managerN: 1,
    joiningDate: '2023-09-04',
  },
  {
    n: 4,
    name: 'Dev HR Head',
    workEmail: 'hrhead@dev.ipro.test',
    designationId: designation.manager,
    departmentId: SEED_ORG.peopleOps,
    managerN: 1,
    joiningDate: '2023-04-03',
  },
  {
    n: 5,
    name: 'Dev HR',
    workEmail: 'hr@dev.ipro.test',
    designationId: designation.hr,
    departmentId: SEED_ORG.peopleOps,
    managerN: 4,
    joiningDate: '2024-01-08',
  },
  {
    n: 6,
    name: 'Dev Employee',
    workEmail: 'employee@dev.ipro.test',
    designationId: designation.engineer,
    departmentId: SEED_ORG.engineering,
    managerN: 2,
    joiningDate: '2024-07-01',
  },
  {
    n: 7,
    name: 'Asha Synthetic',
    workEmail: null,
    designationId: designation.senior,
    departmentId: SEED_ORG.engineering,
    managerN: 2,
    joiningDate: '2024-02-12',
  },
  {
    n: 8,
    name: 'Bala Synthetic',
    workEmail: null,
    designationId: designation.associate,
    departmentId: SEED_ORG.engineering,
    managerN: 2,
    joiningDate: '2025-08-04',
  },
  {
    n: 9,
    name: 'Chitra Synthetic',
    workEmail: null,
    designationId: designation.engineer,
    departmentId: SEED_ORG.quality,
    managerN: 3,
    joiningDate: '2024-11-11',
  },
  {
    n: 10,
    name: 'Deepak Synthetic',
    workEmail: null,
    designationId: designation.engineer,
    departmentId: SEED_ORG.quality,
    managerN: 3,
    joiningDate: '2025-03-03',
    type: 'retainer',
  },
];

export async function seedPeople(tx: Tx, tenantId: string): Promise<void> {
  const t = { tenantId };
  for (const p of people) {
    const personId = id(2000 + p.n);
    const engagementId = id(3000 + p.n);
    const inserted = await tx
      .insert(schema.persons)
      .values({ ...t, id: personId, legalName: p.name })
      .onConflictDoNothing()
      .returning({ id: schema.persons.id });
    if (inserted.length === 0) continue;
    const employeeCode = `IDS-${String(p.n).padStart(4, '0')}`;
    await tx.insert(schema.engagements).values({
      ...t,
      id: engagementId,
      personId,
      employeeCode,
      legalEntityId: SEED_ORG.legalEntity,
      type: p.type ?? 'permanent',
      status: 'active',
      workEmail: p.workEmail,
      joiningDate: p.joiningDate,
    });
    await tx.insert(schema.assignments).values({
      ...t,
      id: id(4000 + p.n),
      engagementId,
      effectiveFrom: p.joiningDate,
      designationId: p.designationId,
      gradeId: gradeOf[p.designationId]!,
      departmentId: p.departmentId,
      locationId: SEED_ORG.chennai,
      costCentreId: id(1401),
      managerEngagementId: p.managerN ? id(3000 + p.managerN) : null,
      bucket: p.departmentId === SEED_ORG.peopleOps ? 'administration' : 'billable',
      changeReason: 'Joined',
    });
    await tx.insert(schema.journalEvents).values({
      ...t,
      engagementId,
      personId,
      eventType: 'joined',
      category: 'lifecycle',
      occurredOn: p.joiningDate,
      title: 'Joined',
      detailJson: { employeeCode, viaOfferFlow: false, seeded: true },
      sensitivity: 'public',
      sourceTable: 'engagement',
      sourceId: engagementId,
    });
    if (p.workEmail) {
      await tx
        .update(schema.appUsers)
        .set({ personId })
        .where(sql`lower(${schema.appUsers.email}) = lower(${p.workEmail})`);
    }
  }
  // Dev Manager Two's QA reportees work Sun–Thu for a (synthetic) Middle East customer.
  await tx
    .insert(schema.shiftAssignments)
    .values(
      [9, 10].map((n) => ({
        ...t,
        id: id(5000 + n),
        engagementId: id(3000 + n),
        shiftId: SEED_ORG.middleEastShift,
        effectiveFrom: people.find((p) => p.n === n)!.joiningDate,
        reason: 'Middle East customer project (synthetic)',
      })),
    )
    .onConflictDoNothing();
  // The next code issued after the seed continues the sequence.
  await tx
    .insert(schema.employeeCodeCounters)
    .values({ tenantId, lastValue: people.length })
    .onConflictDoNothing();
}
