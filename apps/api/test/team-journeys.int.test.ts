import type { INestApplication } from '@nestjs/common';
import type { TeamJourneysView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only. Meera manages Ezhil, Malar and Lokesh; Lokesh manages Devi (indirect for
// Meera). Oscar manages Selvi. Prabhu is still on probation; Tara is let go; Uma left last year.
const U = {
  admin: '00000000-0000-4000-8000-000000615001',
  hr: '00000000-0000-4000-8000-000000615002',
  hrHead: '00000000-0000-4000-8000-000000615003',
  cxo: '00000000-0000-4000-8000-000000615004',
  mgr: '00000000-0000-4000-8000-000000615005',
  other: '00000000-0000-4000-8000-000000615006',
  lead: '00000000-0000-4000-8000-000000615007',
  emp: '00000000-0000-4000-8000-000000615008',
};
const email = (id: string) => `${id}@test.ipro.test`;
const today = businessDate(new Date());
const from = addDays(today, -3 * 365);
const to = addDays(today, 183);

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const agents: Record<string, ReturnType<typeof as>> = {};
type Hire = { personId: string; engagementId: string; employeeCode: string };
const p = {} as Record<
  'mgr' | 'other' | 'lead' | 'emp' | 'malar' | 'devi' | 'selvi' | 'prabhu' | 'tara' | 'uma',
  Hire
>;

async function hire(
  name: string,
  joiningDate: string,
  opts: { userId?: string; manager?: string; designation?: string } = {},
) {
  const res = await agents
    .hr!.post('/api/people', {
      person: { legalName: name },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        workEmail: email(opts.userId ?? `${name.replace(/\W/g, '').toLowerCase()}-615`),
        joiningDate,
      },
      assignment: {
        designationId: opts.designation ?? org.softwareEngineer,
        departmentId: org.engineering,
        locationId: org.chennai,
        bucket: 'billable',
        ...(opts.manager ? { managerEngagementId: opts.manager } : {}),
      },
      compensation: { amount: '60000000', rateUnit: 'year' },
    })
    .expect(201);
  return res.body as Hire;
}

const view = async (who: string, query = `scope=all&from=${from}&to=${to}`) =>
  (await agents[who]!.get(`/api/journeys/team?${query}`).expect(200)).body as TeamJourneysView;
const names = (v: TeamJourneysView) => v.people.map((x) => x.name).sort();

beforeAll(async () => {
  tenant = await newTenant(pool, 'Team journey tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Tj Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Tj HR', ['employee', 'hr']);
  await addUser(db, tenant, U.hrHead, 'Tj HR Head', ['employee', 'hr_head']);
  await addUser(db, tenant, U.cxo, 'Tj CXO', ['employee', 'cxo']);
  await addUser(db, tenant, U.mgr, 'Tj Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.other, 'Tj Other', ['employee', 'manager']);
  await addUser(db, tenant, U.lead, 'Tj Lead', ['employee', 'manager']);
  await addUser(db, tenant, U.emp, 'Tj Employee', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  p.mgr = await hire('Meera Manager', '2023-06-01', {
    userId: U.mgr,
    designation: org.id(1605),
  });
  p.other = await hire('Oscar Other', '2023-06-01', { userId: U.other });
  p.lead = await hire('Lokesh Lead', '2023-07-01', {
    userId: U.lead,
    manager: p.mgr.engagementId,
    designation: org.id(1604),
  });
  p.emp = await hire('Ezhil Employee', '2024-01-08', {
    userId: U.emp,
    manager: p.mgr.engagementId,
  });
  p.malar = await hire('Malar Mate', '2024-03-01', { manager: p.mgr.engagementId });
  p.devi = await hire('Devi Deep', '2024-05-01', { manager: p.lead.engagementId });
  p.selvi = await hire('Selvi Stranger', '2024-02-01', { manager: p.other.engagementId });
  // Probation (6 months) ends in about 20 days.
  const probationStart = addDays(addDays(today, 20), -182);
  p.prabhu = await hire('Prabhu Probation', probationStart, { manager: p.mgr.engagementId });
  p.tara = await hire('Tara Terminated', '2024-04-01', { manager: p.mgr.engagementId });
  p.uma = await hire('Uma Underway', '2023-09-01', { manager: p.mgr.engagementId });
  await pool.query(
    `update engagement set confirmation_date = '2024-01-01' where id = any($1::uuid[])`,
    [
      [p.mgr, p.other, p.lead, p.emp, p.malar, p.devi, p.selvi, p.tara, p.uma].map(
        (h) => h.engagementId,
      ),
    ],
  );
  // Uma left last year.
  await pool.query(
    `update engagement set status = 'exited', last_working_date = $2 where id = $1`,
    [p.uma.engagementId, addDays(today, -200)],
  );
  // A raise for Ezhil (pay: HR only) and a promotion for Malar.
  await agents
    .hrHead!.post(`/api/people/${p.emp.personId}/compensation`, {
      amount: '72000000',
      rateUnit: 'year',
      effectiveFrom: addDays(today, -30),
    })
    .expect(201);
  await agents
    .hrHead!.post(`/api/people/${p.malar.personId}/assignments`, {
      designationId: org.id(1603),
      effectiveFrom: addDays(today, -60),
      changeReason: 'Promoted to Senior Software Engineer',
    })
    .expect(201);
  await agents
    .admin!.put('/api/letter-templates/termination', {
      name: 'Termination letter',
      type: 'termination',
      body: 'Dear {{person.legalName}},\n\nYour last day is {{extra.lastWorkingDate}}.',
      approverRole: null,
      signature: 'none',
    })
    .expect(200);
  await agents
    .hrHead!.post(`/api/people/${p.tara.personId}/terminate`, {
      lastWorkingDate: addDays(today, 20),
      reason: 'Role closed',
    })
    .expect(201);
}, 120_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('team journeys (M6, H11; slice 10)', () => {
  it('a manager sees their reports, direct and indirect, not another team', async () => {
    const v = await view('mgr', `scope=team&from=${from}&to=${to}`);
    expect(names(v)).toEqual([
      'Devi Deep',
      'Ezhil Employee',
      'Lokesh Lead',
      'Malar Mate',
      'Prabhu Probation',
      'Tara Terminated',
      'Uma Underway',
    ]);
    expect(v.people.find((x) => x.name === 'Devi Deep')!.manager).toMatchObject({
      name: 'Lokesh Lead',
    });
  });

  it('HR and CXO see everyone; employees can’t open it', async () => {
    expect(names(await view('hr'))).toContain('Selvi Stranger');
    expect(names(await view('cxo'))).toContain('Selvi Stranger');
    await agents.emp!.get(`/api/journeys/team?scope=team&from=${from}&to=${to}`).expect(403);
  });

  it('carries what the grouping needs: manager, department, band, tenure, status', async () => {
    const v = await view('hr');
    const lokesh = v.people.find((x) => x.name === 'Lokesh Lead')!;
    expect(lokesh).toMatchObject({
      designation: 'Tech Lead',
      band: 'senior_lead',
      department: 'Engineering',
      manager: { name: 'Meera Manager' },
      status: 'active',
    });
    expect(lokesh.tenureYears).toBeGreaterThanOrEqual(3);
    expect(v.people.find((x) => x.name === 'Tara Terminated')).toMatchObject({
      status: 'on_notice',
      lastWorkingDate: addDays(today, 20),
    });
    expect(v.people.find((x) => x.name === 'Prabhu Probation')).toMatchObject({
      onProbation: true,
    });
  });

  it('shows pay events to HR, never to a manager', async () => {
    const forHr = (await view('hr')).people.find((x) => x.name === 'Ezhil Employee')!;
    expect(forHr.events.map((e) => e.category)).toContain('pay');
    const forManager = (await view('mgr', `scope=team&from=${from}&to=${to}`)).people.find(
      (x) => x.name === 'Ezhil Employee',
    )!;
    expect(forManager.events.map((e) => e.category)).not.toContain('pay');
    expect(forManager.events.map((e) => e.type)).toContain('joined');
    const tara = (await view('mgr', `scope=team&from=${from}&to=${to}`)).people.find(
      (x) => x.name === 'Tara Terminated',
    )!;
    expect(tara.events.map((e) => e.type)).not.toContain('terminated');
  });

  it('sums up the view in tiles, and leaves out people who left when asked', async () => {
    const v = await view('mgr', `scope=team&from=${from}&to=${to}`);
    expect(v.tiles).toMatchObject({
      headcount: 6,
      exitedInView: 1,
      probationDue30: 1,
      onNotice: 1,
      designationChanges12m: 1,
    });
    const current = await view('mgr', `scope=team&from=${from}&to=${to}&exited=false`);
    expect(names(current)).not.toContain('Uma Underway');
  });

  it('keeps events to the range asked for', async () => {
    const v = await view('hr', `scope=all&from=${addDays(today, -90)}&to=${to}`);
    for (const person of v.people) {
      for (const e of person.events) expect(e.date >= addDays(today, -90)).toBe(true);
    }
    const bad = await agents
      .hr!.get(`/api/journeys/team?scope=all&from=${to}&to=${from}`)
      .expect(400);
    expect(bad.body.message).toBe('Choose a range that ends after it starts, up to 10 years');
  });
});
