import type { INestApplication } from '@nestjs/common';
import type { PersonTimelineView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { TimelineService } from '../src/journey/timeline.service.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only. Kiran joined 40 days ago on probation, was promoted and given a raise;
// Lekha is let go by HR head.
const U = {
  admin: '00000000-0000-4000-8000-000000614001',
  hr: '00000000-0000-4000-8000-000000614002',
  hrHead: '00000000-0000-4000-8000-000000614003',
  mgr: '00000000-0000-4000-8000-000000614004',
  kiran: '00000000-0000-4000-8000-000000614005',
  lekha: '00000000-0000-4000-8000-000000614006',
};
const email = (id: string) => `${id}@test.ipro.test`;
const today = businessDate(new Date());
const joined = addDays(today, -40);

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const agents: Record<string, ReturnType<typeof as>> = {};
type Hire = { personId: string; engagementId: string; employeeCode: string };
let mgr: Hire;
let kiran: Hire;
let lekha: Hire;

async function hire(
  name: string,
  userId: string,
  joiningDate: string,
  managerEngagementId?: string,
) {
  const res = await agents
    .hr!.post('/api/people', {
      person: { legalName: name },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        workEmail: email(userId),
        joiningDate,
      },
      assignment: {
        designationId: org.softwareEngineer,
        departmentId: org.engineering,
        locationId: org.chennai,
        bucket: 'billable',
        ...(managerEngagementId ? { managerEngagementId } : {}),
      },
      compensation: { amount: '60000000', rateUnit: 'year' },
    })
    .expect((r) => {
      if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    });
  return res.body as Hire;
}

const timeline = async (who: string, h: Hire) =>
  (await agents[who]!.get(`/api/people/${h.personId}/timeline`).expect(200))
    .body as PersonTimelineView;
const payViews = async () =>
  (
    await pool.query(
      `select count(*)::int as n from audit_log where tenant_id = $1 and action = 'view'
         and table_name = 'compensation'`,
      [tenant],
    )
  ).rows[0].n as number;

beforeAll(async () => {
  tenant = await newTenant(pool, 'Journey timeline tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Jt Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Jt HR', ['employee', 'hr']);
  await addUser(db, tenant, U.hrHead, 'Jt HR Head', ['employee', 'hr_head']);
  await addUser(db, tenant, U.mgr, 'Jt Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.kiran, 'Jt Kiran', ['employee']);
  await addUser(db, tenant, U.lekha, 'Jt Lekha', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  mgr = await hire('Meenal Manager', U.mgr, '2023-06-01');
  kiran = await hire('Kiran Kumar', U.kiran, joined, mgr.engagementId);
  lekha = await hire('Lekha Lal', U.lekha, '2023-06-01', mgr.engagementId);
  // A promotion and a raise ten days ago.
  await agents
    .hrHead!.post(`/api/people/${kiran.personId}/assignments`, {
      designationId: org.id(1604),
      effectiveFrom: addDays(today, -10),
      changeReason: 'Promoted to Tech Lead',
    })
    .expect(201);
  await agents
    .hrHead!.post(`/api/people/${kiran.personId}/compensation`, {
      amount: '72000000',
      rateUnit: 'year',
      effectiveFrom: addDays(today, -10),
    })
    .expect(201);
  // Planned events: the next work anniversary (written by the nightly job).
  await runWithContext({ tenantId: tenant }, () => app.get(TimelineService).planAhead(new Date()));
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
    .hrHead!.post(`/api/people/${lekha.personId}/terminate`, {
      lastWorkingDate: addDays(today, 15),
      reason: 'Repeated policy breaches',
    })
    .expect(201);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('the person timeline (E8, H2; slice 10)', () => {
  it('shows each event in its category, with the planned probation end and anniversary ahead', async () => {
    const view = await timeline('hr', kiran);
    expect(view.person).toMatchObject({
      name: 'Kiran Kumar',
      status: 'active',
      joiningDate: joined,
      lastWorkingDate: null,
    });
    const byType = Object.fromEntries(view.events.map((e) => [e.type, e]));
    expect(byType.joined).toMatchObject({ category: 'lifecycle', date: joined, upcoming: false });
    expect(byType.assignment_changed).toMatchObject({
      category: 'career',
      title: 'Promoted to Tech Lead',
    });
    expect(byType.compensation_changed).toMatchObject({ category: 'pay' });
    expect(byType.probation_end).toMatchObject({
      category: 'lifecycle',
      title: 'Probation ends',
      upcoming: true,
      planned: true,
    });
    expect(byType.work_anniversary).toMatchObject({
      date: `${Number(joined.slice(0, 4)) + 1}${joined.slice(4)}`,
      title: '1 year at the company',
      upcoming: true,
    });
    expect(view.events.map((e) => e.date)).toEqual([...view.events.map((e) => e.date)].sort());
  });

  it('draws designation, team and status lanes from the assignment history', async () => {
    const view = await timeline('hr', kiran);
    expect(view.lanes.designation.map((s) => [s.label, s.from, s.to])).toEqual([
      ['Software Engineer', joined, addDays(today, -11)],
      ['Tech Lead', addDays(today, -10), null],
    ]);
    expect(view.lanes.team.map((s) => s.label)).toEqual(['Engineering']);
    expect(view.lanes.status[0]).toMatchObject({ label: 'On probation', from: joined });
    expect(view.tiles).toMatchObject({ designations: 2, designationChanges: 1 });
  });

  it('shows the CTC lane to pay readers only, with one audit entry per view', async () => {
    const before = await payViews();
    const forHr = await timeline('hr', kiran);
    expect(forHr.lanes.ctc!.map((s) => [s.amountPaise, s.from, s.to])).toEqual([
      ['60000000', joined, addDays(today, -11)],
      ['72000000', addDays(today, -10), null],
    ]);
    expect(forHr.tiles.ctcGrowth).toEqual({
      fromPaise: '60000000',
      toPaise: '72000000',
      revisions: 1,
    });
    expect(await payViews()).toBe(before + 1);
    // The person sees their own.
    expect((await timeline('kiran', kiran)).lanes.ctc).toHaveLength(2);
  });
});

describe('what a manager sees (slice 10 done-when #2)', () => {
  it('no compensation events and no CTC for their team, and no audit entry', async () => {
    const before = await payViews();
    const view = await timeline('mgr', kiran);
    expect(view.events.map((e) => e.type)).not.toContain('compensation_changed');
    expect(view.lanes.ctc).toBeNull();
    expect(view.tiles.ctcGrowth).toBeNull();
    expect(await payViews()).toBe(before);
  });

  it('no exit-reason events: the last day ahead, not why', async () => {
    const forHr = await timeline('hr', lekha);
    expect(forHr.events.map((e) => e.type)).toContain('terminated');
    const forManager = await timeline('mgr', lekha);
    const types = forManager.events.map((e) => e.type);
    expect(types).not.toContain('terminated');
    expect(forManager.events.find((e) => e.type === 'last_working_day')).toMatchObject({
      upcoming: true,
      date: addDays(today, 15),
    });
    expect(JSON.stringify(forManager)).not.toContain('Repeated policy breaches');
    expect(forManager.person.status).toBe('on_notice');
  });

  it('an employee can’t open someone else’s timeline', async () => {
    await agents.kiran!.get(`/api/people/${lekha.personId}/timeline`).expect(403);
  });
});

describe('planned events (decision #84)', () => {
  it('writes the next anniversary once, and a planned event past its day becomes a happened one', async () => {
    await runWithContext({ tenantId: tenant }, () =>
      app.get(TimelineService).planAhead(new Date()),
    );
    const { rows } = await pool.query(
      `select count(*)::int as n from journal_event where tenant_id = $1 and person_id = $2
         and event_type = 'work_anniversary'`,
      [tenant, kiran.personId],
    );
    expect(rows[0].n).toBe(1);
    // A year on, last year's anniversary has happened and the next one is planned.
    await runWithContext({ tenantId: tenant }, () =>
      app.get(TimelineService).planAhead(new Date(`${addDays(joined, 366)}T06:00:00+05:30`)),
    );
    const after = await pool.query(
      `select is_planned, occurred_on::text as d from journal_event where tenant_id = $1
         and person_id = $2 and event_type = 'work_anniversary' order by occurred_on`,
      [tenant, kiran.personId],
    );
    expect(after.rows.map((r) => r.is_planned)).toEqual([false, true]);
  });
});
