import type { INestApplication } from '@nestjs/common';
import type { OrgTree } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only.
const HR = '00000000-0000-4000-8000-00000000d001';
const ADMIN = '00000000-0000-4000-8000-00000000d002';
const LEAD = '00000000-0000-4000-8000-00000000d003';
const CXO = '00000000-0000-4000-8000-00000000d004';
const RETAINER = '00000000-0000-4000-8000-00000000d005';
const email = (id: string) => `${id}@test.ipro.test`;

const { pool, db } = testDb();
let app: INestApplication;
let hr: ReturnType<typeof as>;
/** HR head makes direct role changes (decision #62); HR asks through a change request. */
let hrHead: ReturnType<typeof as>;
let org: ReturnType<typeof seedOrgIds>;
const ids: Record<string, { personId: string; engagementId: string }> = {};

const person = (
  legalName: string,
  options: { workEmail?: string; manager?: string; type?: string; joiningDate?: string } = {},
) => ({
  person: { legalName },
  engagement: {
    legalEntityId: org.legalEntity,
    type: options.type ?? 'permanent',
    workEmail: options.workEmail,
    joiningDate: options.joiningDate ?? '2025-01-06',
  },
  assignment: {
    designationId: org.softwareEngineer,
    departmentId: org.engineering,
    locationId: org.chennai,
    managerEngagementId: options.manager,
    bucket: 'billable',
  },
});

beforeAll(async () => {
  const tenant = await newTenant(pool, 'Org tree tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, '00000000-0000-4000-8000-00000000d0aa', 'Direct HR Head', [
    'employee',
    'hr_head',
  ]);
  await addUser(db, tenant, HR, 'Tree HR', ['employee', 'hr']);
  await addUser(db, tenant, ADMIN, 'Tree Admin', ['admin']);
  await addUser(db, tenant, LEAD, 'Tree Lead', ['employee', 'manager']);
  await addUser(db, tenant, CXO, 'Tree CXO', ['employee', 'cxo']);
  await addUser(db, tenant, RETAINER, 'Tree Retainer', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  hr = as(app, await signIn(app, HR));
  hrHead = as(app, await signIn(app, '00000000-0000-4000-8000-00000000d0aa'));
  for (const [key, body] of [
    ['lead', person('Lata Lead', { workEmail: email(LEAD) })],
    ['other', person('Omar Otherlead')],
  ] as const) {
    ids[key] = (await hr.post('/api/people', body).expect(201)).body;
  }
  ids.ana = (
    await hr
      .post('/api/people', person('Ana Analyst', { manager: ids.lead!.engagementId }))
      .expect(201)
  ).body;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const tree = async (asOf: string, viewer = hr): Promise<OrgTree> =>
  (await viewer.get(`/api/org-tree?asOf=${asOf}`).expect(200)).body;
const node = (t: OrgTree, personId: string) => t.people.find((p) => p.personId === personId);

describe('org tree as of a date (done-when #2)', () => {
  beforeAll(async () => {
    // A department rename from 1 Feb, then Ana moves to Quality under another lead from 1 Mar.
    const admin = as(app, await signIn(app, ADMIN));
    await admin
      .post(`/api/org/units/departments/${org.engineering}/changes`, {
        effectiveFrom: '2026-02-01',
        name: 'Product Engineering',
      })
      .expect(201);
    await hrHead
      .post(`/api/people/${ids.ana!.personId}/assignments`, {
        effectiveFrom: '2026-03-01',
        departmentId: org.quality,
        managerEngagementId: ids.other!.engagementId,
        changeReason: 'Moved to Quality',
      })
      .expect(201);
  });

  it('before joining, the person is not in the tree', async () => {
    expect(node(await tree('2025-01-05'), ids.ana!.personId)).toBeUndefined();
  });

  it('each past date matches the assignments and department names in force that day', async () => {
    const january = await tree('2026-01-31');
    expect(node(january, ids.ana!.personId)).toMatchObject({
      managerPersonId: ids.lead!.personId,
      departmentId: org.engineering,
      departmentName: 'Engineering',
    });
    expect(january.departments.find((d) => d.departmentId === org.engineering)?.name).toBe(
      'Engineering',
    );

    const february = await tree('2026-02-15');
    expect(node(february, ids.ana!.personId)).toMatchObject({
      managerPersonId: ids.lead!.personId,
      departmentName: 'Product Engineering',
    });

    const march = await tree('2026-03-01');
    expect(node(march, ids.ana!.personId)).toMatchObject({
      managerPersonId: ids.other!.personId,
      departmentId: org.quality,
      departmentName: 'Quality Engineering',
    });
    const quality = march.departments.find((d) => d.departmentId === org.quality);
    expect(quality).toMatchObject({
      parentDepartmentId: org.engineering,
      headcount: 1,
      businessUnitName: 'Delivery',
    });
  });

  it('agrees with the assignment rows for every sampled date', async () => {
    for (const asOf of ['2025-01-06', '2025-12-31', '2026-02-28', '2026-03-01', '2027-01-01']) {
      const { rows } = await pool.query(
        `select e.person_id, a.department_id, me.person_id as manager_person_id
         from assignment a join engagement e on e.id = a.engagement_id
         left join engagement me on me.id = a.manager_engagement_id
         where e.tenant_id = (select tenant_id from engagement where id = $2)
           and a.effective_from <= $1 and (a.effective_to is null or a.effective_to >= $1)`,
        [asOf, ids.ana!.engagementId],
      );
      const t = await tree(asOf);
      expect(
        t.people.map((p) => [p.personId, p.departmentId, p.managerPersonId]).sort(),
        asOf,
      ).toEqual(rows.map((r) => [r.person_id, r.department_id, r.manager_person_id]).sort());
    }
  });

  it('a manager sees their own team only; CXO sees everyone', async () => {
    const lead = as(app, await signIn(app, LEAD));
    const leadView = await tree('2026-01-31', lead);
    expect(leadView.people.map((p) => p.personId).sort()).toEqual(
      [ids.lead!.personId, ids.ana!.personId].sort(),
    );
    // After the move Ana is no longer in Lata's team.
    const leadMarch = await tree('2026-03-01', lead);
    expect(node(leadMarch, ids.ana!.personId)).toBeUndefined();
    const cxo = as(app, await signIn(app, CXO));
    expect((await tree('2026-03-01', cxo)).people).toHaveLength(3);
  });
});

describe('retainer converted to payroll (done-when #3)', () => {
  let retainer: { personId: string; engagementId: string; employeeCode: string };

  beforeAll(async () => {
    retainer = (
      await hr
        .post('/api/people', {
          ...person('Ravi Retainer', {
            type: 'retainer',
            workEmail: email(RETAINER),
            manager: ids.lead!.engagementId,
          }),
          compensation: { amount: '15000000', rateUnit: 'month' },
        })
        .expect(201)
    ).body;
  });

  it('refuses future dates, non-retainer engagements and a missing probation choice', async () => {
    await hr
      .post(`/api/people/${retainer.personId}/convert`, {
        effectiveFrom: '2025-07-01',
        type: 'permanent',
      })
      .expect(400);
    await hr
      .post(`/api/people/${retainer.personId}/convert`, {
        effectiveFrom: '2999-01-01',
        type: 'permanent',
        probation: 'none',
      })
      .expect(400);
    await hr
      .post(`/api/people/${ids.ana!.personId}/convert`, {
        effectiveFrom: '2025-07-01',
        type: 'permanent',
        probation: 'none',
      })
      .expect(400);
  });

  it('keeps one person, one employee code and one continuous history', async () => {
    const converted = await hr
      .post(`/api/people/${retainer.personId}/convert`, {
        effectiveFrom: '2025-07-01',
        type: 'permanent',
        probation: 'none',
        compensation: { amount: '240000000', rateUnit: 'year' },
      })
      .expect(201);
    expect(converted.body).toMatchObject({
      personId: retainer.personId,
      employeeCode: retainer.employeeCode,
      engagementType: 'permanent',
      status: 'active',
    });
    expect(converted.body.engagementId).not.toBe(retainer.engagementId);

    const directory = await hr.get('/api/people?q=Ravi').expect(200);
    expect(directory.body).toHaveLength(1);

    const { rows: engagements } = await pool.query(
      `select id, type, status, last_working_date::text, exit_reason, previous_engagement_id, employee_code,
              probation_end_date
       from engagement where person_id = $1 order by joining_date`,
      [retainer.personId],
    );
    expect(engagements).toMatchObject([
      {
        type: 'retainer',
        status: 'exited',
        last_working_date: '2025-06-30',
        exit_reason: 'converted_to_payroll',
      },
      {
        type: 'permanent',
        status: 'active',
        previous_engagement_id: retainer.engagementId,
        probation_end_date: null, // HR and CXO chose no probation for this conversion
      },
    ]);
    expect(new Set(engagements.map((e) => e.employee_code)).size).toBe(1);

    const assignments = await hr.get(`/api/people/${retainer.personId}/assignments`).expect(200);
    expect(
      assignments.body.map(
        (a: { effectiveFrom: string; effectiveTo: string | null; engagementType: string }) => [
          a.engagementType,
          a.effectiveFrom,
          a.effectiveTo,
        ],
      ),
    ).toEqual([
      ['retainer', '2025-01-06', '2025-06-30'],
      ['permanent', '2025-07-01', null],
    ]);
    const pay = await hr.get(`/api/people/${retainer.personId}/compensation`).expect(200);
    expect(
      pay.body.map((c: { amount: string; rateUnit: string; effectiveTo: string | null }) => [
        c.amount,
        c.rateUnit,
        c.effectiveTo,
      ]),
    ).toEqual([
      ['15000000', 'month', '2025-06-30'],
      ['240000000', 'year', null],
    ]);
  });

  it('the journey is one timeline across both engagements', async () => {
    const journey = await hr.get(`/api/people/${retainer.personId}/journey`).expect(200);
    expect(
      journey.body.map((e: { eventType: string; occurredOn: string; employeeCode: string }) => [
        e.eventType,
        e.occurredOn,
        e.employeeCode,
      ]),
    ).toEqual([
      ['joined', '2025-01-06', retainer.employeeCode],
      ['converted', '2025-07-01', retainer.employeeCode],
    ]);
  });

  it('the person still signs in as the same person, and the manager keeps them in the team', async () => {
    const self = as(app, await signIn(app, RETAINER));
    expect((await self.get('/api/me').expect(200)).body.personId).toBe(retainer.personId);
    const lead = as(app, await signIn(app, LEAD));
    await lead.get(`/api/people/${retainer.personId}`).expect(200);
    await lead.get(`/api/people/${retainer.personId}/journey`).expect(200);
  });

  it('a manager never sees compensation events in the journey; HR does', async () => {
    await hr
      .post(`/api/people/${retainer.personId}/compensation`, {
        effectiveFrom: '2026-04-01',
        amount: '270000000',
        rateUnit: 'year',
      })
      .expect(201);
    const types = (body: { eventType: string }[]) => body.map((e) => e.eventType);
    const hrView = await hr.get(`/api/people/${retainer.personId}/journey`).expect(200);
    expect(types(hrView.body)).toContain('compensation_changed');
    const lead = as(app, await signIn(app, LEAD));
    const leadView = await lead.get(`/api/people/${retainer.personId}/journey`).expect(200);
    expect(types(leadView.body)).toEqual(['joined', 'converted']);
  });
});
