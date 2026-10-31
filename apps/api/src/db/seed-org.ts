// Synthetic org structure for dev. Fixed ids keep the seed idempotent and links stable.
import * as schema from './schema.js';
import type { Tx } from './tenant-context.js';

/** Seed org ids. `prefix` (8 hex digits) keeps several seeded tenants apart in tests. */
export function seedOrgIds(prefix = '00000000') {
  const id = (n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    id,
    legalEntity: id(1001),
    delivery: id(1101),
    corporate: id(1102),
    engineering: id(1201),
    quality: id(1202),
    peopleOps: id(1203),
    finance: id(1204),
    chennai: id(1301),
    clientSite: id(1302),
    remote: id(1303),
    softwareEngineer: id(1602),
  };
}

export const SEED_ORG = seedOrgIds();

const FROM = '2023-04-01';
const lakh = (n: number) => BigInt(n) * 100_000n * 100n; // ₹ lakh → paise

export async function seedOrg(tx: Tx, tenantId: string, prefix?: string): Promise<void> {
  const ids = seedOrgIds(prefix);
  const id = ids.id;
  const t = { tenantId };
  await tx
    .insert(schema.legalEntities)
    .values({ ...t, id: ids.legalEntity, name: 'Ideassion India (dev)', country: 'IN' })
    .onConflictDoNothing();

  for (const [unitId, code, name] of [
    [ids.delivery, 'DEL', 'Delivery'],
    [ids.corporate, 'CORP', 'Corporate'],
  ] as const) {
    await tx
      .insert(schema.businessUnits)
      .values({ ...t, id: unitId, code })
      .onConflictDoNothing();
    await tx
      .insert(schema.businessUnitVersions)
      .values({
        ...t,
        id: unitId.replace('-0000-4000', '-0001-4000'),
        businessUnitId: unitId,
        name,
        effectiveFrom: FROM,
      })
      .onConflictDoNothing();
  }

  for (const [unitId, code, name, bu, parent] of [
    [ids.engineering, 'ENG', 'Engineering', ids.delivery, null],
    [ids.quality, 'QA', 'Quality Engineering', ids.delivery, ids.engineering],
    [ids.peopleOps, 'HR', 'People Operations', ids.corporate, null],
    [ids.finance, 'FIN', 'Finance', ids.corporate, null],
  ] as const) {
    await tx
      .insert(schema.departments)
      .values({ ...t, id: unitId, code })
      .onConflictDoNothing();
    await tx
      .insert(schema.departmentVersions)
      .values({
        ...t,
        id: unitId.replace('-0000-4000', '-0001-4000'),
        departmentId: unitId,
        name,
        businessUnitId: bu,
        parentDepartmentId: parent,
        effectiveFrom: FROM,
      })
      .onConflictDoNothing();
  }

  for (const [unitId, code, name, type, seats] of [
    [ids.chennai, 'CHN', 'Chennai office', 'office', 80],
    [ids.clientSite, 'CLIENT', 'Client site', 'client_site', null],
    [ids.remote, 'REMOTE', 'Remote', 'remote', null],
  ] as const) {
    await tx
      .insert(schema.locations)
      .values({ ...t, id: unitId, code, legalEntityId: ids.legalEntity })
      .onConflictDoNothing();
    await tx
      .insert(schema.locationVersions)
      .values({
        ...t,
        id: unitId.replace('-0000-4000', '-0001-4000'),
        locationId: unitId,
        name,
        type,
        state: type === 'office' ? 'Tamil Nadu' : null,
        seatCount: seats,
        effectiveFrom: FROM,
      })
      .onConflictDoNothing();
  }

  await tx
    .insert(schema.costCentres)
    .values([
      { ...t, id: id(1401), code: 'CC-DEL', name: 'Delivery' },
      { ...t, id: id(1402), code: 'CC-CORP', name: 'Corporate' },
    ])
    .onConflictDoNothing();

  // Synthetic bands, not Ideassion's (to be supplied in the policy workshop).
  const grades = [
    [id(1501), 'G1', 'Associate', 3, 6, 1],
    [id(1502), 'G2', 'Engineer', 6, 10, 2],
    [id(1503), 'G3', 'Senior Engineer', 10, 18, 3],
    [id(1504), 'G4', 'Lead', 18, 28, 4],
    [id(1505), 'G5', 'Manager', 28, 45, 5],
  ] as const;
  await tx
    .insert(schema.grades)
    .values(
      grades.map(([gradeId, code, name, min, max, level]) => ({
        ...t,
        id: gradeId,
        code,
        name,
        bandMin: lakh(min),
        bandMax: lakh(max),
        levelOrder: level,
      })),
    )
    .onConflictDoNothing();

  await tx
    .insert(schema.designations)
    .values([
      {
        ...t,
        id: id(1601),
        title: 'Associate Engineer',
        gradeId: id(1501),
        designationBand: 'associate',
      },
      {
        ...t,
        id: id(1602),
        title: 'Software Engineer',
        gradeId: id(1502),
        designationBand: 'associate',
      },
      {
        ...t,
        id: id(1603),
        title: 'Senior Software Engineer',
        gradeId: id(1503),
        designationBand: 'senior_lead',
      },
      { ...t, id: id(1604), title: 'Tech Lead', gradeId: id(1504), designationBand: 'senior_lead' },
      {
        ...t,
        id: id(1605),
        title: 'Engineering Manager',
        gradeId: id(1505),
        designationBand: 'manager_plus',
      },
      {
        ...t,
        id: id(1606),
        title: 'HR Executive',
        gradeId: id(1502),
        designationBand: 'associate',
      },
    ])
    .onConflictDoNothing();
}
