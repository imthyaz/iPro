import type { INestApplication } from '@nestjs/common';
import type { ApprovalCard, NotificationView, WeekPlanView, WorkPolicyView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { HybridService } from '../src/hybrid/hybrid.service.js';
import { mondayOf } from '../src/hybrid/hybrid-rules.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only. Weeks are planned two or more weeks ahead, so the cut-off never bites
// except where a test means it to.
const U = {
  admin: '00000000-0000-4000-8000-000000608001',
  hr: '00000000-0000-4000-8000-000000608002',
  mgr: '00000000-0000-4000-8000-000000608003',
  emp: '00000000-0000-4000-8000-000000608004',
  mate: '00000000-0000-4000-8000-000000608005',
  ret: '00000000-0000-4000-8000-000000608006',
  onsite: '00000000-0000-4000-8000-000000608007',
};
const email = (id: string) => `${id}@test.ipro.test`;
const today = businessDate(new Date());
const W = addDays(mondayOf(today), 14);
const day = (week: string, i: number) => addDays(week, i);

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const agents: Record<string, ReturnType<typeof as>> = {};
type Hire = { personId: string; engagementId: string; employeeCode: string };
const p = {} as Record<'mgr' | 'emp' | 'mate' | 'ret' | 'onsite', Hire>;

type Mode = 'office' | 'wfh' | 'client_site' | null;
const plan = (who: string, week: string, modes: Mode[], extra: object = {}) =>
  agents[who]!.put('/api/hybrid/week', {
    weekStart: week,
    days: modes.map((mode, i) => ({ date: day(week, i), mode })),
    ...extra,
  });
const weekOf = async (who: string, week: string) =>
  (await agents[who]!.get(`/api/hybrid/week?start=${week}`).expect(200)).body as WeekPlanView;
const cards = async (who: string) =>
  (await agents[who]!.get('/api/approvals').expect(200)).body as ApprovalCard[];

async function hire(
  name: string,
  userId: string,
  type: 'permanent' | 'retainer',
  locationId: string,
  managerEngagementId?: string,
): Promise<Hire> {
  const res = await agents
    .hr!.post('/api/people', {
      person: { legalName: name },
      engagement: {
        legalEntityId: org.legalEntity,
        type,
        workEmail: email(userId),
        joiningDate: '2024-01-08',
      },
      assignment: {
        designationId: org.softwareEngineer,
        departmentId: org.engineering,
        locationId,
        bucket: 'billable',
        ...(managerEngagementId ? { managerEngagementId } : {}),
      },
    })
    .expect(201);
  return res.body;
}

beforeAll(async () => {
  tenant = await newTenant(pool, 'Hybrid tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Hy Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Hy HR', ['employee', 'hr']);
  await addUser(db, tenant, U.mgr, 'Hy Manager', ['employee', 'manager']);
  for (const key of ['emp', 'mate', 'ret', 'onsite'] as const) {
    await addUser(db, tenant, U[key], `Hy ${key}`, ['employee']);
  }
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  p.mgr = await hire('Meera Manager', U.mgr, 'permanent', org.chennai);
  p.emp = await hire('Ezra Employee', U.emp, 'permanent', org.chennai, p.mgr.engagementId);
  p.mate = await hire('Maya Mate', U.mate, 'permanent', org.chennai, p.mgr.engagementId);
  p.ret = await hire('Ravi Retainer', U.ret, 'retainer', org.chennai, p.mgr.engagementId);
  p.onsite = await hire('Oviya Onsite', U.onsite, 'permanent', org.clientSite, p.mgr.engagementId);
  const shift = await agents
    .admin!.post('/api/shifts', {
      code: 'WEEKDAY',
      name: 'Monday to Friday',
      startTime: '09:00',
      endTime: '18:00',
      graceMinutes: 0,
      weeklyOffs: [6, 7],
    })
    .expect(201);
  await agents
    .hr!.post('/api/shifts/allocations', {
      personIds: [p.mgr, p.emp, p.mate, p.ret, p.onsite].map((h) => h.personId),
      shiftId: shift.body.id,
      effectiveFrom: '2024-01-08',
      reason: 'Test shift',
    })
    .expect(201);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('work policies (decision #78: the spec’s proposed policies)', () => {
  it('starts from the confirmed defaults, matched by location type, engagement type and priority', async () => {
    const policies = (await agents.admin!.get('/api/work-policies').expect(200))
      .body as WorkPolicyView[];
    expect(policies.map((x) => [x.code, x.requiredMode, x.requiredDays, x.priority])).toEqual([
      ['ONSITE', 'client_site', 5, 10],
      ['REMOTE', 'office', 0, 20],
      ['HYBRID', 'office', 3, 30],
    ]);
    expect((await weekOf('emp', W)).policy).toMatchObject({ name: 'Hybrid: 3 office days' });
    expect((await weekOf('ret', W)).policy).toMatchObject({ name: 'Remote-first' });
    expect((await weekOf('onsite', W)).policy).toMatchObject({ name: 'Client on-site' });
    await agents.emp!.get('/api/work-policies').expect(403);
  });
});

describe('planning a week (E6; spec workflow 6)', () => {
  it('confirms a week within policy at once', async () => {
    const before = await weekOf('emp', W);
    expect(before.days).toHaveLength(7);
    expect(before.days.slice(0, 5).every((d) => d.working && d.editable)).toBe(true);
    expect(before.days[5]!.working).toBe(false);
    expect(before.fit).toMatchObject({ target: 3, booked: 0, fits: false });
    expect(before.homeLocationId).toBe(org.chennai);

    const res = await plan('emp', W, ['office', 'office', 'office', 'wfh', 'wfh']).expect(200);
    const after = res.body as WeekPlanView;
    expect(after.fit).toEqual({ target: 3, booked: 3, fits: true, reasons: [] });
    expect(after.days.slice(0, 5).map((d) => d.booking?.status)).toEqual(
      Array(5).fill('confirmed'),
    );
    expect(after.days[0]!.booking).toMatchObject({
      mode: 'office',
      locationId: org.chennai,
      locationName: 'Chennai office',
    });
    expect(after.exception).toBeNull();
    expect((await cards('mgr')).filter((c) => c.title.startsWith('Hybrid'))).toHaveLength(0);
  });

  it('asks for the manager’s approval below policy, with the reason on the card', async () => {
    const week = addDays(W, 7);
    const refused = await plan('emp', week, ['office', 'wfh', 'wfh', 'wfh', 'wfh']).expect(400);
    expect(refused.body.message).toBe('This week is below your policy: say why for your manager');
    expect(refused.body.problems).toEqual(['1 of 3 office days booked']);

    const sent = (
      await plan('emp', week, ['office', 'wfh', 'wfh', 'wfh', 'wfh'], {
        note: 'Release week, working with the US team late',
      }).expect(200)
    ).body as WeekPlanView;
    expect(sent.days.slice(0, 5).map((d) => d.booking?.status)).toEqual(Array(5).fill('pending'));
    expect(sent.exception).toMatchObject({ status: 'pending' });

    const card = (await cards('mgr')).find((c) => c.subject.personId === p.emp.personId)!;
    expect(card.title).toMatch(/^Hybrid week below policy: Ezra Employee, week of /);
    const lines = Object.fromEntries(card.changes.map((c) => [c.label, c.to]));
    expect(lines['Policy fit']).toBe('Hybrid: 3 office days · 1 of 3 office days booked');
    expect(lines['Reason']).toBe('Release week, working with the US team late');
    expect(lines['Plan']).toContain('Office (Chennai office)');
    await agents.mgr!.post(`/api/approvals/${card.approvalId}/approve`, {}).expect(201);

    const approved = await weekOf('emp', week);
    expect(approved.days.slice(0, 5).map((d) => d.booking?.status)).toEqual(
      Array(5).fill('confirmed'),
    );
    expect(approved.exception).toMatchObject({ status: 'approved' });
  });

  it('counts the team’s anchor day, set by the manager', async () => {
    await agents.emp!.put('/api/hybrid/team-anchor', { weekday: 3 }).expect(403);
    await agents.mgr!.put('/api/hybrid/team-anchor', { weekday: 3 }).expect(200);
    expect((await agents.mgr!.get('/api/hybrid/team-anchor').expect(200)).body).toEqual({
      weekday: 3,
    });
    const week = addDays(W, 14);
    const res = await plan('emp', week, ['office', 'office', 'wfh', 'office', 'wfh']).expect(400);
    expect(res.body.problems).toEqual([
      expect.stringMatching(/^The team’s anchor day \(Wed \d+ \w+\) isn’t an office day$/),
    ]);
    expect((await weekOf('emp', week)).anchorWeekday).toBe(3);
    await plan('emp', week, ['office', 'wfh', 'office', 'office', 'wfh']).expect(200);
  });

  it('can’t be changed after 18:00 the day before', async () => {
    const res = await agents
      .emp!.put('/api/hybrid/week', {
        weekStart: mondayOf(today),
        days: [{ date: today, mode: 'wfh' }],
      })
      .expect(400);
    expect(res.body.message).toMatch(/is past the cut-off \(18:00 the day before\)$/);
    const view = await weekOf('emp', mondayOf(today));
    expect(view.days.find((d) => d.date === today)?.editable).toBe(false);
  });

  it('refuses a mode the policy doesn’t allow, and fits the other policies', async () => {
    const res = await plan('onsite', W, [
      'office',
      'client_site',
      'client_site',
      'client_site',
      'client_site',
    ]).expect(400);
    expect(res.body.message).toMatch(/^Office isn’t allowed by your policy/);
    await plan('onsite', W, Array(5).fill('client_site')).expect(200);
    // Remote-first: nothing required, so an empty week fits.
    expect((await weekOf('ret', W)).fit.fits).toBe(true);
  });
});

describe('seats (spec data model: Seat)', () => {
  it('blocks double-booking a seat', async () => {
    const seat = (
      await agents
        .admin!.post('/api/seats', { locationId: org.chennai, label: 'A1', zone: 'North' })
        .expect(201)
    ).body as { id: string };
    await agents.emp!.post('/api/seats', { locationId: org.chennai, label: 'A2' }).expect(403);
    await agents
      .emp!.put('/api/hybrid/week', {
        weekStart: W,
        days: [
          { date: day(W, 0), mode: 'office', locationId: org.chennai, seatId: seat.id },
          { date: day(W, 1), mode: 'office' },
          { date: day(W, 2), mode: 'office' },
          { date: day(W, 3), mode: 'wfh' },
          { date: day(W, 4), mode: 'wfh' },
        ],
      })
      .expect(200);
    const taken = await agents
      .mate!.put('/api/hybrid/week', {
        weekStart: W,
        days: [
          { date: day(W, 0), mode: 'office', locationId: org.chennai, seatId: seat.id },
          { date: day(W, 1), mode: 'office' },
          { date: day(W, 2), mode: 'office' },
        ],
      })
      .expect(409);
    expect(taken.body.message).toMatch(/^Seat A1 is taken on Mon \d+ \w+$/);
    const seats = (
      await agents
        .mate!.get(`/api/hybrid/seats?locationId=${org.chennai}&date=${day(W, 0)}`)
        .expect(200)
    ).body as { label: string; taken: boolean }[];
    expect(seats).toEqual([expect.objectContaining({ label: 'A1', taken: true })]);
    // The database also refuses it, whatever the route.
    await expect(
      pool.query(
        `insert into work_booking (tenant_id, engagement_id, person_id, date, week_start, mode,
           location_id, seat_id, status)
         values ($1, $2, $3, $4, $5, 'office', $6, $7, 'confirmed')`,
        [tenant, p.mate.engagementId, p.mate.personId, day(W, 0), W, org.chennai, seat.id],
      ),
    ).rejects.toThrow(/work_booking_seat_key/);
  });

  it('needs approval for an office day when the office is full', async () => {
    await pool.query(`update location_version set seat_count = 2 where location_id = $1`, [
      org.chennai,
    ]);
    // Ezra has Monday to Wednesday in the office; Meera books Monday too: 2 of 2.
    await plan('mgr', W, ['office', 'office', 'office', 'wfh', 'wfh']).expect(200);
    const res = await plan('mate', W, ['office', 'office', 'office', 'wfh', 'wfh']).expect(400);
    // Monday to Wednesday are all full.
    expect(res.body.problems).toHaveLength(3);
    expect(res.body.problems[0]).toMatch(
      /^Chennai office is full on Mon \d+ \w+ \(2 of 2 seats\)$/,
    );
    await pool.query(`update location_version set seat_count = 80 where location_id = $1`, [
      org.chennai,
    ]);
  });
});

describe('the Friday reminder (spec notifications: hybrid week below policy)', () => {
  it('reminds people whose next week is below policy, once', async () => {
    // The Friday before a week no one has planned.
    const week = addDays(W, 28);
    const friday = new Date(`${addDays(week, -3)}T12:00:00+05:30`);
    const run = () =>
      runWithContext({ tenantId: tenant }, () => app.get(HybridService).remindBelowPolicy(friday));
    const first = await run();
    // Ezra, Maya, Meera and Oviya are below policy; Ravi is remote-first.
    expect(first.reminded).toBe(4);
    expect((await run()).reminded).toBe(0);
    const notes = (await agents.emp!.get('/api/notifications').expect(200))
      .body as NotificationView[];
    expect(notes.find((n) => n.title.startsWith('Plan next week'))).toMatchObject({
      title: 'Plan next week: 0 of 3 office days booked',
      link: `/hybrid?week=${week}`,
    });
  });
});
