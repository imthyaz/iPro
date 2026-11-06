import type { INestApplication } from '@nestjs/common';
import type { LeaveBalanceRow, LeaveTypeView, PayrollExportView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDate } from '../src/common/effective-dating.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people and a synthetic September 2026 (Sundays off: the 6th, 13th, 20th and 27th),
// written straight into the attendance and leave tables so the month can be counted by hand.
const U = {
  admin: '00000000-0000-4000-8000-000000607001',
  hr: '00000000-0000-4000-8000-000000607002',
  mgr: '00000000-0000-4000-8000-000000607003',
  cxo: '00000000-0000-4000-8000-000000607004',
  emp: '00000000-0000-4000-8000-000000607005',
};
const email = (id: string) => `${id}@test.ipro.test`;
const MONTH = '2026-09';
const SUNDAYS = new Set([6, 13, 20, 27]);
const date = (n: number) => `${MONTH}-${String(n).padStart(2, '0')}`;

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const agents: Record<string, ReturnType<typeof as>> = {};
type Hire = { personId: string; engagementId: string; employeeCode: string };
const p = {} as Record<'mgr' | 'asha' | 'bala' | 'chitra', Hire>;
let types: LeaveTypeView[];
const typeId = (code: string) => types.find((t) => t.code === code)!.id;

async function hire(
  name: string,
  joiningDate: string,
  userId?: string,
  managerEngagementId?: string,
): Promise<Hire> {
  const res = await agents
    .hr!.post('/api/people', {
      person: { legalName: name },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        workEmail: email(userId ?? `${name.replace(/\W/g, '').toLowerCase()}-607`),
        joiningDate,
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
  return res.body;
}

async function attendance(h: Hire, n: number, status: string, mode: string | null) {
  await pool.query(
    `insert into attendance_day (tenant_id, engagement_id, person_id, day, status, mode)
     values ($1, $2, $3, $4, $5, $6)`,
    [tenant, h.engagementId, h.personId, date(n), status, mode],
  );
}

async function leave(h: Hire, n: number, code: string, status: 'approved' | 'applied') {
  const { rows } = await pool.query(
    `insert into leave_request (tenant_id, engagement_id, person_id, leave_type_id, from_date,
       to_date, start_half, end_half, days, status)
     values ($1, $2, $3, $4, $5, $5, 'full', 'full', 100, $6) returning id`,
    [tenant, h.engagementId, h.personId, typeId(code), date(n), status],
  );
  await pool.query(
    `insert into leave_request_day (tenant_id, request_id, engagement_id, person_id, day, half,
       leave_type_id, amount)
     values ($1, $2, $3, $4, $5, 'full', $6, 100)`,
    [tenant, rows[0].id, h.engagementId, h.personId, date(n), typeId(code)],
  );
}

const view = async (month = MONTH) =>
  (await agents.hr!.get(`/api/payroll-export?month=${month}`).expect(200))
    .body as PayrollExportView;
const rowOf = (v: PayrollExportView, h: Hire) => v.rows.find((r) => r.personId === h.personId)!;

beforeAll(async () => {
  tenant = await newTenant(pool, 'Payroll export tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Pe Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Pe HR', ['employee', 'hr']);
  await addUser(db, tenant, U.mgr, 'Pe Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.cxo, 'Pe CXO', ['employee', 'cxo']);
  await addUser(db, tenant, U.emp, 'Pe Employee', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  p.mgr = await hire('Mohan Manager', '2024-01-08', U.mgr);
  p.asha = await hire('Asha Ash', '2024-01-08', U.emp, p.mgr.engagementId);
  p.bala = await hire('Bala Bell', '2026-09-16', undefined, p.mgr.engagementId);
  p.chitra = await hire('Chitra Chand', '2024-01-08', undefined, p.mgr.engagementId);
  const shift = await agents
    .admin!.post('/api/shifts', {
      code: 'SIXDAY',
      name: 'Monday to Saturday',
      startTime: '09:00',
      endTime: '18:00',
      graceMinutes: 0,
      weeklyOffs: [7],
    })
    .expect(201);
  await agents
    .hr!.post('/api/shifts/allocations', {
      personIds: [p.mgr.personId, p.asha.personId, p.bala.personId, p.chitra.personId],
      shiftId: shift.body.id,
      effectiveFrom: '2024-01-08',
      reason: 'Test shift',
    })
    .expect(201);
  types = (await agents.hr!.get('/api/leave-types').expect(200)).body;

  // Asha: WFH on the 2nd, casual leave on the 4th, absent on the 7th, a half day on the 8th, loss
  // of pay leave on the 10th, nothing at all on the 14th; present on every other working day.
  const asha: Record<number, () => Promise<void>> = {
    2: () => attendance(p.asha, 2, 'wfh', 'wfh'),
    4: async () => {
      await attendance(p.asha, 4, 'leave', null);
      await leave(p.asha, 4, 'CL', 'approved');
    },
    7: () => attendance(p.asha, 7, 'absent', null),
    8: () => attendance(p.asha, 8, 'half_day', 'office'),
    10: async () => {
      await attendance(p.asha, 10, 'leave', null);
      await leave(p.asha, 10, 'LOP', 'approved');
    },
    14: async () => undefined,
  };
  for (let n = 1; n <= 30; n++) {
    if (SUNDAYS.has(n)) continue;
    await (asha[n] ?? (() => attendance(p.asha, n, 'present', 'office')))();
    if (n >= 16) await attendance(p.bala, n, 'present', 'office');
    if (n === 21) {
      // Chitra: absent on the 21st with leave asked for and not yet approved.
      await attendance(p.chitra, n, 'absent', null);
      await leave(p.chitra, n, 'CL', 'applied');
    } else {
      await attendance(p.chitra, n, 'present', 'office');
    }
    await attendance(p.mgr, n, 'present', 'office');
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('the monthly attendance and LOP export (slice 7 done-when #3; decision #77)', () => {
  it('matches the hand count for the synthetic September', async () => {
    const v = await view();
    // 30 days, 26 working. Asha: LOP 7th (1) + 8th (0.5) + 10th LOP leave (1) + 14th (1) = 3.5.
    expect(rowOf(v, p.asha)).toMatchObject({
      employeeCode: p.asha.employeeCode,
      name: 'Asha Ash',
      calendarDays: 30,
      employedDays: 30,
      present: 20.5,
      wfh: 1,
      clientSite: 0,
      paidLeave: 1,
      lopLeave: 1,
      lopAbsent: 2.5,
      lop: 3.5,
      payableDays: 26.5,
      weeklyOffs: 4,
      holidays: 0,
      joinedOn: null,
      leftOn: null,
      pending: 0,
      adjustment: null,
    });
    expect(rowOf(v, p.asha).lopDays).toEqual([
      { date: date(7), days: 1, why: 'Absent, no leave' },
      { date: date(8), days: 0.5, why: 'Half day, no leave for the other half' },
      { date: date(10), days: 1, why: 'Loss-of-pay leave' },
      { date: date(14), days: 1, why: 'No attendance recorded, no leave' },
    ]);
    // Bala joined on the 16th: 15 days employed, 13 working, 2 Sundays.
    expect(rowOf(v, p.bala)).toMatchObject({
      joinedOn: '2026-09-16',
      employedDays: 15,
      present: 13,
      weeklyOffs: 2,
      lop: 0,
      payableDays: 15,
    });
    // Chitra's leave isn't decided: the day counts as it stands, and HR is warned.
    expect(rowOf(v, p.chitra)).toMatchObject({ lop: 1, payableDays: 29, pending: 1 });
    expect(v.pending).toEqual([
      expect.objectContaining({
        personId: p.chitra.personId,
        date: date(21),
        what: 'Casual leave asked for, not yet approved',
      }),
    ]);
    expect(v.totals).toMatchObject({ people: 4, lop: 4.5, adjustments: 0 });
  });

  it('downloads the CSV, records the export, and audits it', async () => {
    const res = await agents.hr!.get(`/api/payroll-export/csv?month=${MONTH}`).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain('attendance-2026-09.csv');
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe(
      'employee_code,name,department,joining_date,last_working_date,calendar_days,employed_days,payable_days,present_days,wfh_days,client_site_days,paid_leave_days,lop_leave_days,lop_absent_days,lop_days,weekly_off_days,holiday_days,pending_requests,lop_adjustment_days,lop_adjustment_note',
    );
    expect(lines.find((l) => l.startsWith(p.asha.employeeCode))).toMatch(
      new RegExp(
        `^${p.asha.employeeCode},Asha Ash,[^,]*,,,30,30,26.5,20.5,1,0,1,1,2.5,3.5,4,0,0,,$`,
      ),
    );
    expect((await view()).exports).toHaveLength(1);
    const { rows } = await pool.query(
      `select count(*)::int as n from audit_log where tenant_id = $1 and action = 'export'
         and table_name = 'payroll_export'`,
      [tenant],
    );
    expect(rows[0].n).toBe(1);
  });

  it('carries a late correction into next month as an adjustment', async () => {
    await agents
      .hr!.post('/api/attendance/corrections', {
        days: [{ personId: p.asha.personId, date: date(7) }],
        status: 'present',
        reason: 'Was at a client workshop',
      })
      .expect(201);
    const october = await view('2026-10');
    expect(october.previousExportedAt).not.toBeNull();
    expect(rowOf(october, p.asha).adjustment).toEqual({
      days: -1,
      note: 'September: loss of pay 3.5 → 2.5 since it was exported',
    });
    expect(rowOf(october, p.bala).adjustment).toBeNull();
    expect(october.totals.adjustments).toBe(1);
  });

  it('is only for a month that is over', async () => {
    const res = await agents
      .hr!.get(`/api/payroll-export?month=${businessDate(new Date()).slice(0, 7)}`)
      .expect(400);
    expect(res.body.message).toBe('Export a month once it is over');
  });

  it('is for HR only: not managers, CXO or employees', async () => {
    await agents.mgr!.get(`/api/payroll-export?month=${MONTH}`).expect(403);
    await agents.cxo!.get(`/api/payroll-export/csv?month=${MONTH}`).expect(403);
    await agents.emp!.get(`/api/payroll-export?month=${MONTH}`).expect(403);
  });
});

describe('H9 leave balances for HR', () => {
  it('lists each person with the balance of each type', async () => {
    const csv = [
      'employee_code,leave_type,balance',
      `${p.asha.employeeCode},CL,4`,
      `${p.chitra.employeeCode},SL,2.5`,
    ].join('\n');
    await agents
      .hr!.post('/api/leave/balances/import', { csv, asOf: '2026-10-31', commit: true })
      .expect(200);
    const rows = (await agents.hr!.get('/api/leave/balances?year=2026').expect(200))
      .body as LeaveBalanceRow[];
    const asha = rows.find((r) => r.personId === p.asha.personId)!;
    expect(asha).toMatchObject({ employeeCode: p.asha.employeeCode, name: 'Asha Ash' });
    expect(asha.balances.find((b) => b.code === 'CL')?.balance).toBe(4);
    expect(
      rows.find((r) => r.personId === p.chitra.personId)!.balances.find((b) => b.code === 'SL')
        ?.balance,
    ).toBe(2.5);
    await agents.mgr!.get('/api/leave/balances?year=2026').expect(403);
    await agents.cxo!.get('/api/leave/balances?year=2026').expect(403);
  });
});
