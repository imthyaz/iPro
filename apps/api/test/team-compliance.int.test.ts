import type { INestApplication } from '@nestjs/common';
import type { ComplianceView, LeaveTypeView, TeamCalendarView, TeamTodayView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { ComplianceService } from '../src/hybrid/compliance.service.js';
import { mondayOf } from '../src/hybrid/hybrid-rules.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only. Every day is a working day on the test shift, so "today" never falls on a
// weekly off. P is last week (over); bookings and attendance are written straight in, as they would
// be by the time a week has passed.
const U = {
  admin: '00000000-0000-4000-8000-000000609001',
  hr: '00000000-0000-4000-8000-000000609002',
  mgr: '00000000-0000-4000-8000-000000609003',
  other: '00000000-0000-4000-8000-000000609004',
  cxo: '00000000-0000-4000-8000-000000609005',
  emp: '00000000-0000-4000-8000-000000609006',
  mate: '00000000-0000-4000-8000-000000609007',
  away: '00000000-0000-4000-8000-000000609008',
};
const email = (id: string) => `${id}@test.ipro.test`;
const today = businessDate(new Date());
const P = addDays(mondayOf(today), -7);
const pd = (i: number) => addDays(P, i);

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const agents: Record<string, ReturnType<typeof as>> = {};
type Hire = { personId: string; engagementId: string; employeeCode: string };
const p = {} as Record<'mgr' | 'other' | 'emp' | 'mate' | 'away' | 'stranger', Hire>;
let types: LeaveTypeView[];

async function hire(name: string, userId: string | null, managerEngagementId?: string) {
  const res = await agents
    .hr!.post('/api/people', {
      person: { legalName: name },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        workEmail: email(userId ?? `${name.replace(/\W/g, '').toLowerCase()}-609`),
        joiningDate: '2024-01-08',
      },
      assignment: {
        designationId: org.softwareEngineer,
        departmentId: org.engineering,
        locationId: org.chennai,
        bucket: 'billable',
        ...(managerEngagementId ? { managerEngagementId } : {}),
      },
    })
    .expect(201);
  return res.body as Hire;
}

async function book(h: Hire, date: string, mode: string, status = 'confirmed') {
  await pool.query(
    `insert into work_booking (tenant_id, engagement_id, person_id, date, week_start, mode,
       location_id, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      tenant,
      h.engagementId,
      h.personId,
      date,
      mondayOf(date),
      mode,
      mode === 'wfh' ? null : org.chennai,
      status,
    ],
  );
}

async function attend(h: Hire, date: string, status: string, mode: string | null) {
  await pool.query(
    `insert into attendance_day (tenant_id, engagement_id, person_id, day, status, mode, first_in)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      tenant,
      h.engagementId,
      h.personId,
      date,
      status,
      mode,
      mode ? new Date(`${date}T09:12:00+05:30`) : null,
    ],
  );
}

async function leave(h: Hire, date: string, status: 'approved' | 'applied') {
  const cl = types.find((t) => t.code === 'CL')!.id;
  const { rows } = await pool.query(
    `insert into leave_request (tenant_id, engagement_id, person_id, leave_type_id, from_date,
       to_date, start_half, end_half, days, status)
     values ($1, $2, $3, $4, $5, $5, 'full', 'full', 100, $6) returning id`,
    [tenant, h.engagementId, h.personId, cl, date, status],
  );
  await pool.query(
    `insert into leave_request_day (tenant_id, request_id, engagement_id, person_id, day, half,
       leave_type_id, amount)
     values ($1, $2, $3, $4, $5, 'full', $6, 100)`,
    [tenant, rows[0].id, h.engagementId, h.personId, date, cl],
  );
}

const run = (on: string) =>
  runWithContext({ tenantId: tenant }, () => app.get(ComplianceService).runDaily(on));
const compliance = async (who: string) =>
  (await agents[who]!.get(`/api/hybrid/compliance?from=${P}&to=${P}`).expect(200))
    .body as ComplianceView;

beforeAll(async () => {
  tenant = await newTenant(pool, 'Team compliance tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Tc Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Tc HR', ['employee', 'hr']);
  await addUser(db, tenant, U.mgr, 'Tc Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.other, 'Tc Other', ['employee', 'manager']);
  await addUser(db, tenant, U.cxo, 'Tc CXO', ['employee', 'cxo']);
  await addUser(db, tenant, U.emp, 'Tc Employee', ['employee']);
  await addUser(db, tenant, U.mate, 'Tc Mate', ['employee']);
  await addUser(db, tenant, U.away, 'Tc Away', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  p.mgr = await hire('Malar Manager', U.mgr);
  p.other = await hire('Oscar Other', U.other);
  p.emp = await hire('Elan Employee', U.emp, p.mgr.engagementId);
  p.mate = await hire('Mira Mate', U.mate, p.mgr.engagementId);
  p.away = await hire('Anu Away', U.away, p.mgr.engagementId);
  p.stranger = await hire('Selvi Stranger', null, p.other.engagementId);
  const shift = await agents
    .admin!.post('/api/shifts', {
      code: 'ALLWEEK',
      name: 'All week',
      startTime: '00:00',
      endTime: '23:59',
      graceMinutes: 0,
      weeklyOffs: [],
    })
    .expect(201);
  await agents
    .hr!.post('/api/shifts/allocations', {
      personIds: Object.values(p).map((h) => h.personId),
      shiftId: shift.body.id,
      effectiveFrom: '2024-01-08',
      reason: 'Test shift',
    })
    .expect(201);
  types = (await agents.hr!.get('/api/leave-types').expect(200)).body;
  // Makes the default work policies (Hybrid: 3 office days for everyone here).
  await agents.admin!.get('/api/work-policies').expect(200);

  // Elan, last week: planned office Mon to Wed. In on Monday, half a day on Tuesday, home on
  // Wednesday, came in on Thursday though planned WFH, casual leave on Friday.
  await book(p.emp, pd(0), 'office');
  await book(p.emp, pd(1), 'office');
  await book(p.emp, pd(2), 'office');
  await book(p.emp, pd(3), 'wfh');
  await attend(p.emp, pd(0), 'present', 'office');
  await attend(p.emp, pd(1), 'half_day', 'office');
  await attend(p.emp, pd(2), 'wfh', 'wfh');
  await attend(p.emp, pd(3), 'present', 'office');
  await attend(p.emp, pd(4), 'leave', null);
  await leave(p.emp, pd(4), 'approved');
  // Mira: as planned, three days in the office.
  for (const i of [0, 1, 2]) {
    await book(p.mate, pd(i), 'office');
    await attend(p.mate, pd(i), 'present', 'office');
  }
  // Selvi reports to someone else.
  await book(p.stranger, pd(0), 'office');

  // Today: Elan checked in at the office, Mira booked the office and hasn't come in, Anu is on leave.
  await attend(p.emp, today, 'present', 'office');
  await book(p.mate, today, 'office');
  await leave(p.away, today, 'approved');
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('hybrid compliance (M4; slice 8 done-when #3)', () => {
  it('records planned vs actual each night, and the whole week again on Monday', async () => {
    // The Monday after P re-records P's seven days.
    expect(await run(addDays(P, 7))).toMatchObject({ recorded: expect.any(Number), week: P });
    const view = await compliance('mgr');
    const elan = view.people.find((x) => x.personId === p.emp.personId)!;
    // Six days available (Friday on leave); target 3; planned 3; actual 1 + 0.5 + 1 = 2.5.
    expect(elan.weeks).toEqual([
      expect.objectContaining({
        weekStart: P,
        policyName: 'Hybrid: 3 office days',
        target: 3,
        planned: 3,
        actual: 2.5,
        met: false,
        approvedBelow: false,
      }),
    ]);
    expect(elan.weeks[0]!.days.slice(0, 5).map((d) => d.why)).toEqual([
      'Planned office, in the office',
      'Planned office, half a day in the office',
      'Planned office, worked from home',
      'Planned WFH, in the office',
      'On leave',
    ]);
    const mira = view.people.find((x) => x.personId === p.mate.personId)!;
    expect(mira.weeks[0]).toMatchObject({ target: 3, planned: 3, actual: 3, met: true });
    // Exceptions first: Anu (nothing planned or recorded) and Elan missed, by name; Mira met.
    expect(view.people.map((x) => x.personId)).toEqual([
      p.away.personId,
      p.emp.personId,
      p.mate.personId,
    ]);
    expect(view.summary).toEqual([{ weekStart: P, people: 3, met: 1, approvedBelow: 0 }]);
  });

  it('a late correction counts once the week is recorded again; running twice changes nothing', async () => {
    await agents
      .hr!.post('/api/attendance/corrections', {
        days: [{ personId: p.emp.personId, date: pd(2) }],
        status: 'present',
        reason: 'Badge reader fault',
      })
      .expect(201);
    await run(addDays(P, 7));
    await run(addDays(P, 7));
    const elan = (await compliance('mgr')).people.find((x) => x.personId === p.emp.personId)!;
    expect(elan.weeks[0]).toMatchObject({ actual: 3.5, met: true });
    const { rows } = await pool.query(
      `select count(*)::int as n from hybrid_compliance_day where engagement_id = $1`,
      [p.emp.engagementId],
    );
    expect(rows[0].n).toBe(7);
  });

  it('shows a week the manager approved below policy as approved, not missed', async () => {
    const policy = (
      await pool.query(`select id from work_policy where tenant_id = $1 and code = 'HYBRID'`, [
        tenant,
      ])
    ).rows[0].id;
    await pool.query(
      `insert into hybrid_exception (tenant_id, engagement_id, person_id, week_start, policy_id,
         reasons, note, status)
       values ($1, $2, $3, $4, $5, '["1 of 3 office days booked"]', 'Release week', 'approved')`,
      [tenant, p.away.engagementId, p.away.personId, P, policy],
    );
    await run(addDays(P, 7));
    const anu = (await compliance('mgr')).people.find((x) => x.personId === p.away.personId)!;
    expect(anu.weeks[0]).toMatchObject({ actual: 0, met: false, approvedBelow: true });
  });

  it('is for the manager’s team and HR, not other managers, employees or CXO', async () => {
    expect((await compliance('other')).people.map((x) => x.personId)).toEqual([
      p.stranger.personId,
    ]);
    // HR has no team of its own; with "all" it sees the entity.
    expect((await compliance('hr')).people).toEqual([]);
    const all = (
      await agents.hr!.get(`/api/hybrid/compliance?from=${P}&to=${P}&scope=all`).expect(200)
    ).body as ComplianceView;
    expect(all.people.map((x) => x.personId)).toContain(p.emp.personId);
    expect(all.people.map((x) => x.personId)).toContain(p.stranger.personId);
    await agents.emp!.get(`/api/hybrid/compliance?from=${P}&to=${P}`).expect(403);
    await agents.cxo!.get(`/api/hybrid/compliance?from=${P}&to=${P}`).expect(403);
    const range = await agents
      .mgr!.get(`/api/hybrid/compliance?from=${P}&to=${addDays(P, 7 * 14)}`)
      .expect(400);
    expect(range.body.message).toBe('Choose up to 13 weeks');
  });
});

describe('Team today (M2) and the team calendar (M3)', () => {
  it('shows where each person in the team is today', async () => {
    const view = (await agents.mgr!.get('/api/hybrid/team-today').expect(200))
      .body as TeamTodayView;
    const of = (h: Hire) => view.rows.find((r) => r.personId === h.personId);
    expect(of(p.emp)).toMatchObject({ status: 'office' });
    expect(of(p.emp)!.checkedInAt).not.toBeNull();
    expect(of(p.mate)).toMatchObject({ status: 'not_checked_in', planned: 'office' });
    expect(of(p.away)).toMatchObject({ status: 'leave', note: 'Casual leave' });
    expect(of(p.stranger)).toBeUndefined();
    expect(view.counts).toMatchObject({ office: 1, not_checked_in: 1, leave: 1 });
    await agents.emp!.get('/api/hybrid/team-today').expect(403);
  });

  it('shows a month of leave and bookings per person', async () => {
    const view = (
      await agents.mgr!.get(`/api/hybrid/team-calendar?month=${P.slice(0, 7)}`).expect(200)
    ).body as TeamCalendarView;
    const elan = view.people.find((x) => x.personId === p.emp.personId)!;
    expect(elan.days.find((d) => d.date === pd(0))).toMatchObject({
      booking: { mode: 'office', status: 'confirmed' },
      leave: null,
    });
    if (pd(4).slice(0, 7) === P.slice(0, 7)) {
      expect(elan.days.find((d) => d.date === pd(4))!.leave).toEqual({
        code: 'CL',
        half: 'full',
        approved: true,
      });
    }
    expect(view.people.map((x) => x.personId)).not.toContain(p.stranger.personId);
  });
});
