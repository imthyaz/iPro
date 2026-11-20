import type { INestApplication } from '@nestjs/common';
import type {
  AbsenteeismReport,
  AttritionReport,
  ComplianceView,
  HeadcountReport,
  HybridComplianceReport,
  LeaveLiabilityReport,
  LeaveTypeView,
  MovementReport,
  SeatOccupancyReport,
} from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// The hand-calculated synthetic set (slice 13 done-when #1; decision #93). January to June 2026:
//   A Eng 2024-01-08 active · B Quality 2024-03-01 active · C Eng joins 2026-02-10 · D Quality joins
//   2026-04-15 · E Eng left 2026-03-15 (resigned) · F Quality left 2026-05-31 (terminated) · G Eng on
//   notice to 2026-12-31 · H joins 2026-12-15 (not yet).
const U = {
  admin: '00000000-0000-4000-8000-000000685001',
  hr: '00000000-0000-4000-8000-000000685002',
  cxo: '00000000-0000-4000-8000-000000685003',
  mgr: '00000000-0000-4000-8000-000000685004',
  emp: '00000000-0000-4000-8000-000000685005',
};
type Who = keyof typeof U;
type Hire = { personId: string; engagementId: string; employeeCode: string };

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const agents: Record<string, ReturnType<typeof as>> = {};
const p = {} as Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H', Hire>;

const report = async <T>(who: Who, path: string) =>
  (await agents[who]!.get(`/api/reports/${path}`).expect(200)).body as T;

async function hire(name: string, joiningDate: string, department: string): Promise<Hire> {
  const res = await agents
    .hr!.post('/api/people', {
      person: { legalName: name },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        workEmail: `${name.replace(/\W/g, '').toLowerCase()}-685@test.ipro.test`,
        joiningDate,
      },
      assignment: {
        designationId: org.softwareEngineer,
        departmentId: department,
        locationId: org.chennai,
        bucket: 'billable',
      },
      compensation: { amount: '60000000', rateUnit: 'year' },
    })
    .expect(201);
  return res.body as Hire;
}

/** Attendance days as the nightly build would have written them. */
async function days(h: Hire, rows: [string, string][]) {
  for (const [day, status] of rows) {
    await pool.query(
      `insert into attendance_day (tenant_id, engagement_id, person_id, day, status, mode)
       values ($1, $2, $3, $4, $5, $6)`,
      [tenant, h.engagementId, h.personId, day, status, status === 'present' ? 'office' : null],
    );
  }
}

/** An approved leave day, planned or not, as the leave flow would have recorded it. */
async function leaveDay(h: Hire, day: string, unplanned: boolean, leaveTypeId: string) {
  const { rows } = await pool.query(
    `insert into leave_request (tenant_id, engagement_id, person_id, leave_type_id, from_date, to_date,
       start_half, end_half, days, status, unplanned)
     values ($1, $2, $3, $4, $5, $5, 'full', 'full', 100, 'approved', $6) returning id`,
    [tenant, h.engagementId, h.personId, leaveTypeId, day, unplanned],
  );
  await pool.query(
    `insert into leave_request_day (tenant_id, request_id, engagement_id, person_id, day, half,
       leave_type_id, amount)
     values ($1, $2, $3, $4, $5, 'full', $6, 100)`,
    [tenant, rows[0].id, h.engagementId, h.personId, day, leaveTypeId],
  );
}

beforeAll(async () => {
  tenant = await newTenant(pool, 'Report tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Rp Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Rp HR', ['employee', 'hr']);
  await addUser(db, tenant, U.cxo, 'Rp CXO', ['employee', 'cxo']);
  await addUser(db, tenant, U.mgr, 'Rp Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.emp, 'Rp Employee', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));

  p.A = await hire('Anbu A', '2024-01-08', org.engineering);
  p.B = await hire('Bala B', '2024-03-01', org.quality);
  p.C = await hire('Chitra C', '2026-02-10', org.engineering);
  p.D = await hire('Devi D', '2026-04-15', org.quality);
  p.E = await hire('Elango E', '2023-06-01', org.engineering);
  p.F = await hire('Farida F', '2024-05-01', org.quality);
  p.G = await hire('Gopi G', '2025-01-01', org.engineering);
  p.H = await hire('Hari H', '2026-12-15', org.engineering);
  await pool.query(
    `update engagement set status = 'exited', last_working_date = '2026-03-15',
       resignation_date = '2026-02-13', exit_reason = 'resigned' where id = $1`,
    [p.E.engagementId],
  );
  await pool.query(
    `update engagement set status = 'exited', last_working_date = '2026-05-31',
       exit_reason = 'terminated' where id = $1`,
    [p.F.engagementId],
  );
  await pool.query(
    `update engagement set status = 'on_notice', last_working_date = '2026-12-31',
       resignation_date = '2026-10-01' where id = $1`,
    [p.G.engagementId],
  );

  // Absenteeism, Mon 2 to Fri 6 March 2026.
  const types = (await agents.hr!.get('/api/leave-types').expect(200)).body as LeaveTypeView[];
  const cl = types.find((t) => t.code === 'CL')!.id;
  await days(p.A, [
    ['2026-03-02', 'present'],
    ['2026-03-03', 'present'],
    ['2026-03-04', 'absent'],
    ['2026-03-05', 'leave'],
    ['2026-03-06', 'present'],
    ['2026-03-07', 'weekly_off'],
  ]);
  await leaveDay(p.A, '2026-03-05', true, cl);
  await days(p.B, [
    ['2026-03-02', 'present'],
    ['2026-03-03', 'leave'],
    ['2026-03-04', 'present'],
    ['2026-03-05', 'present'],
    ['2026-03-06', 'present'],
  ]);
  await leaveDay(p.B, '2026-03-03', false, cl);
  await days(p.C, [
    ['2026-03-02', 'present'],
    ['2026-03-03', 'present'],
    ['2026-03-04', 'half_day'],
    ['2026-03-05', 'present'],
    ['2026-03-06', 'present'],
  ]);

  // Leave balances for 2026: CL A 3, B 2, C 1; EL A 10, B 5.
  await agents
    .hr!.post('/api/leave/balances/import', {
      csv: [
        'employee_code,leave_type,balance',
        `${p.A.employeeCode},CL,3`,
        `${p.A.employeeCode},EL,10`,
        `${p.B.employeeCode},CL,2`,
        `${p.B.employeeCode},EL,5`,
        `${p.C.employeeCode},CL,1`,
      ].join('\n'),
      asOf: '2026-03-01',
      commit: true,
    })
    .expect(200);

  // Two seats at Chennai; bookings on Mon (2) and Tue (1).
  const seat = async (label: string) =>
    (await agents.admin!.post('/api/seats', { locationId: org.chennai, label }).expect(201)).body
      .id as string;
  const [s1, s2] = [await seat('R1'), await seat('R2')];
  for (const [h, day, seatId] of [
    [p.A, '2026-03-02', s1],
    [p.B, '2026-03-02', s2],
    [p.A, '2026-03-03', s1],
  ] as const) {
    await pool.query(
      `insert into work_booking (tenant_id, engagement_id, person_id, date, week_start, mode,
         location_id, seat_id, status)
       values ($1, $2, $3, $4, '2026-03-02', 'office', $5, $6, 'confirmed')`,
      [tenant, h.engagementId, h.personId, day, org.chennai, seatId],
    );
  }

  // Hybrid week of 2 March: A attended the office 2 of 2 required days; B none.
  await agents.admin!.get('/api/work-policies').expect(200);
  const policy = (
    await pool.query(
      `select id from work_policy where tenant_id = $1 order by created_at limit 1`,
      [tenant],
    )
  ).rows[0].id as string;
  for (const [h, officeDays] of [
    [p.A, 2],
    [p.B, 0],
  ] as const) {
    for (let i = 0; i < 5; i++) {
      const date = `2026-03-0${2 + i}`;
      const office = i < officeDays;
      await pool.query(
        `insert into hybrid_compliance_day (tenant_id, engagement_id, person_id, date, week_start,
           policy_id, required_mode, required_days, working, on_leave, planned_mode, actual_status,
           actual_mode)
         values ($1, $2, $3, $4, '2026-03-02', $5, 'office', 2, true, false, $6, $7, $8)`,
        [
          tenant,
          h.engagementId,
          h.personId,
          date,
          policy,
          office ? 'office' : 'wfh',
          office ? 'present' : 'wfh',
          office ? 'office' : 'wfh',
        ],
      );
    }
  }
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('H12 reports match the hand-calculated values (slice 13 done-when #1)', () => {
  it('headcount on 31 March: 5 (Engineering 3, Quality 2)', async () => {
    const r = await report<HeadcountReport>('hr', 'headcount?asOf=2026-03-31');
    expect(r.total).toBe(5);
    expect(r.byDepartment).toEqual([
      { name: 'Engineering', count: 3 },
      { name: 'Quality Engineering', count: 2 },
    ]);
    expect(r.byType).toEqual([{ name: 'permanent', count: 5 }]);
  });

  it('joiners and leavers, January to June: 2 and 2, by month and department', async () => {
    const r = await report<MovementReport>('hr', 'movement?from=2026-01-01&to=2026-06-30');
    expect(r).toMatchObject({ joiners: 2, leavers: 2 });
    expect(r.months).toEqual([
      { month: '2026-02', joiners: 1, leavers: 0 },
      { month: '2026-03', joiners: 0, leavers: 1 },
      { month: '2026-04', joiners: 1, leavers: 0 },
      { month: '2026-05', joiners: 0, leavers: 1 },
    ]);
    expect(r.joinerList.map((x) => [x.name, x.date])).toEqual([
      ['Chitra C', '2026-02-10'],
      ['Devi D', '2026-04-15'],
    ]);
    expect(r.leaversByDepartment).toEqual([
      { name: 'Engineering', count: 1 },
      { name: 'Quality Engineering', count: 1 },
    ]);
  });

  it('attrition: 2 ÷ 5.5 = 36.4%, 72.7% annualised; 1 voluntary, 1 involuntary', async () => {
    const r = await report<AttritionReport>('hr', 'attrition?from=2026-01-01&to=2026-06-30');
    expect(r.monthEnds.map((m) => m.headcount)).toEqual([5, 6, 5, 6, 6, 5]);
    expect(r).toMatchObject({
      leavers: 2,
      voluntary: 1,
      involuntary: 1,
      unknown: 0,
      averageHeadcount: 5.5,
      rate: 36.4,
      annualised: 72.7,
    });
  });

  it('absenteeism, 2–6 March: (1 unplanned + 1 absent) ÷ 15 = 13.3%', async () => {
    const r = await report<AbsenteeismReport>('hr', 'absenteeism?from=2026-03-02&to=2026-03-08');
    expect(r).toMatchObject({ workingDays: 15, unplannedLeaveDays: 1, absentDays: 1, rate: 13.3 });
    expect(r.byDepartment).toEqual([
      { name: 'Engineering', workingDays: 10, unplannedLeaveDays: 1, absentDays: 1, rate: 20 },
      {
        name: 'Quality Engineering',
        workingDays: 5,
        unplannedLeaveDays: 0,
        absentDays: 0,
        rate: 0,
      },
    ]);
  });

  it('leave liability for 2026: CL 6, EL 15 days; EL worth 15 × ₹6,00,000 ÷ 365', async () => {
    const r = await report<LeaveLiabilityReport>('hr', 'leave-liability?year=2026');
    expect(r.byType.filter((t) => t.code === 'CL' || t.code === 'EL')).toEqual([
      { code: 'CL', name: 'Casual leave', days: 6, encashable: false },
      { code: 'EL', name: 'Earned leave', days: 15, encashable: true },
    ]);
    expect(r.byDepartment.map((d) => [d.name, d.days.CL, d.days.EL])).toEqual([
      ['Engineering', 4, 10],
      ['Quality Engineering', 2, 5],
    ]);
    // A: 60,000,000 × 1,000 ÷ 36,500 = 1,643,835; B: × 500 ÷ 36,500 = 821,917 (paise, floored).
    expect(r.value).toEqual({
      paise: '2465752',
      people: 2,
      byType: [{ code: 'EL', paise: '2465752' }],
    });
    // Each pay read is audited.
    const { rows } = await pool.query(
      `select count(*)::int as n from audit_log where table_name = 'compensation' and action = 'view'
         and created_by = $1`,
      [U.hr],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('hybrid compliance, week of 2 March: 1 of 2 met = 50%, as on the compliance screen', async () => {
    const r = await report<HybridComplianceReport>(
      'hr',
      'hybrid-compliance?from=2026-03-02&to=2026-03-06',
    );
    expect(r.weeks).toEqual([
      { weekStart: '2026-03-02', people: 2, met: 1, approvedBelow: 0, rate: 50 },
    ]);
    expect(r.rate).toBe(50);
    const screen = (
      await agents
        .hr!.get('/api/hybrid/compliance?from=2026-03-02&to=2026-03-02&scope=all')
        .expect(200)
    ).body as ComplianceView;
    expect(screen.summary).toEqual([
      { weekStart: '2026-03-02', people: 2, met: 1, approvedBelow: 0 },
    ]);
  });

  it('seat occupancy, 2–6 March: 3 seat-days of 2 seats × 5 days = 30%; peak 100% on the 2nd', async () => {
    const r = await report<SeatOccupancyReport>(
      'hr',
      'seat-occupancy?from=2026-03-02&to=2026-03-06',
    );
    expect(r.byLocation).toEqual([
      {
        location: 'Chennai office',
        seats: 2,
        workingDays: 5,
        bookedSeatDays: 3,
        average: 30,
        peak: 100,
        peakDate: '2026-03-02',
      },
    ]);
  });
});

describe('who can see the reports', () => {
  it('CXO sees the same aggregates as HR', async () => {
    expect(await report<AttritionReport>('cxo', 'attrition?from=2026-01-01&to=2026-06-30')).toEqual(
      await report<AttritionReport>('hr', 'attrition?from=2026-01-01&to=2026-06-30'),
    );
    expect(
      (await report<AbsenteeismReport>('cxo', 'absenteeism?from=2026-03-02&to=2026-03-08')).rate,
    ).toBe(13.3);
    expect(
      (
        await report<HybridComplianceReport>(
          'cxo',
          'hybrid-compliance?from=2026-03-02&to=2026-03-06',
        )
      ).rate,
    ).toBe(50);
  });

  it('managers and employees can’t open them', async () => {
    for (const who of ['mgr', 'emp'] as const) {
      await agents[who]!.get('/api/reports/headcount?asOf=2026-03-31').expect(403);
      await agents[who]!.get('/api/reports/leave-liability?year=2026').expect(403);
      await agents[who]!.get('/api/reports/seat-occupancy?from=2026-03-02&to=2026-03-06').expect(
        403,
      );
    }
  });

  it('refuses a backwards or over-long range', async () => {
    await agents.hr!.get('/api/reports/attrition?from=2026-06-30&to=2026-01-01').expect(400);
    await agents.hr!.get('/api/reports/absenteeism?from=2024-01-01&to=2026-06-30').expect(400);
  });
});
