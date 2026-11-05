import type { INestApplication } from '@nestjs/common';
import type { LeaveBalanceView, LeaveImportResult, LeaveTypeView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDate } from '../src/common/effective-dating.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { LeaveService } from '../src/leave/leave.service.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only.
const U = {
  admin: '00000000-0000-4000-8000-000000604001',
  hr: '00000000-0000-4000-8000-000000604002',
  mgr: '00000000-0000-4000-8000-000000604003',
  emp: '00000000-0000-4000-8000-000000604004',
  other: '00000000-0000-4000-8000-000000604005',
  cxo: '00000000-0000-4000-8000-000000604006',
};
const email = (id: string) => `${id}@test.ipro.test`;

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const agents: Record<string, ReturnType<typeof as>> = {};
type Hire = { personId: string; engagementId: string; employeeCode: string };
// A: confirmed, permanent. B: joined 16 Mar, on probation. C: intern. D: consultant.
const p = {} as Record<'mgr' | 'a' | 'b' | 'c' | 'd', Hire>;

const service = () => app.get(LeaveService);
const run = <T>(fn: (s: LeaveService) => Promise<T>) =>
  runWithContext({ tenantId: tenant }, () => fn(service()));
const balances = async (who: Hire, year: number, agent = agents.hr!) =>
  (await agent.get(`/api/people/${who.personId}/leave?year=${year}`).expect(200))
    .body as LeaveBalanceView[];
const balance = async (who: Hire, code: string, year = 2026) =>
  (await balances(who, year)).find((b) => b.leaveType.code === code);

async function hire(
  name: string,
  type: string,
  joiningDate: string,
  extra: { userId?: string; manager?: string } = {},
): Promise<Hire> {
  const res = await agents
    .hr!.post('/api/people', {
      person: { legalName: name },
      engagement: {
        legalEntityId: org.legalEntity,
        type,
        joiningDate,
        ...(extra.userId ? { workEmail: email(extra.userId) } : {}),
      },
      assignment: {
        designationId: org.softwareEngineer,
        departmentId: org.engineering,
        locationId: org.chennai,
        bucket: 'billable',
        ...(extra.manager ? { managerEngagementId: extra.manager } : {}),
      },
    })
    .expect(201);
  return res.body;
}

beforeAll(async () => {
  tenant = await newTenant(pool, 'Leave tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Lv Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Lv HR', ['employee', 'hr']);
  await addUser(db, tenant, U.mgr, 'Lv Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.emp, 'Lv Employee', ['employee']);
  await addUser(db, tenant, U.other, 'Lv Other', ['employee']);
  await addUser(db, tenant, U.cxo, 'Lv CXO', ['employee', 'cxo']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  p.mgr = await hire('Lata Manager', 'permanent', '2024-01-08', { userId: U.mgr });
  p.a = await hire('Arun Confirmed', 'permanent', '2024-01-08', {
    userId: U.emp,
    manager: p.mgr.engagementId,
  });
  p.b = await hire('Bina Joiner', 'permanent', '2026-03-16');
  p.c = await hire('Chitra Intern', 'intern', '2025-12-01', { userId: U.other });
  p.d = await hire('Dev Consultant', 'consultant', '2025-01-06');
  await pool.query(`update engagement set confirmation_date = '2024-07-08' where id = $1`, [
    p.a.engagementId,
  ]);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('leave types (decisions #71, #73)', () => {
  it('start from the confirmed policy; admins and HR head edit them, HR reads', async () => {
    const types = (await agents.emp!.get('/api/leave-types').expect(200)).body as LeaveTypeView[];
    expect(types.map((t) => t.code)).toEqual(['CL', 'SL', 'EL', 'CO', 'ML', 'PTL', 'BL', 'LOP']);
    expect(types.find((t) => t.code === 'EL')).toMatchObject({
      daysPerYear: 15,
      creditOn: 'month_end',
      accruesAfterConfirmation: true,
      availableOnProbation: false,
      maxBalance: 30,
      carryForwardCap: 30,
      encashable: true,
    });
    expect(types.find((t) => t.code === 'SL')).toMatchObject({
      daysPerYear: 12,
      creditOn: 'month_start',
      documentAfterDays: 2,
    });
    expect(types.find((t) => t.code === 'CL')!.creditOn).toBe('month_start');
    expect(types.find((t) => t.code === 'PTL')!.maxDaysPerRequest).toBe(5);
    expect(types.find((t) => t.code === 'BL')!.maxDaysPerRequest).toBe(3);
    const el = types.find((t) => t.code === 'EL')!;
    const { id: _id, sortOrder: _s, ...body } = el;
    await agents.hr!.put(`/api/leave-types/${el.id}`, body).expect(403);
    await agents.hr!.post('/api/leave-types', { ...body, code: 'X' }).expect(403);
    await agents.admin!.put(`/api/leave-types/${el.id}`, { ...body, code: 'ELX' }).expect(400);
  });
});

describe('monthly accrual (done-when #1)', () => {
  it('credits March by the rules, once, to the people each type applies to', async () => {
    expect((await run((s) => s.accrueMonth('2026-03'))).credited).toBe(
      // A: CL, SL, EL. B: CL, SL (EL: on probation). C intern: CL, SL. Manager: CL, SL, EL? No —
      // the manager has no confirmation date recorded yet, so CL and SL only. D consultant: none.
      3 + 2 + 2 + 2,
    );
    expect((await run((s) => s.accrueMonth('2026-03'))).credited).toBe(0);

    expect(await balance(p.a, 'CL')).toMatchObject({ accrued: 1, balance: 1 });
    expect(await balance(p.a, 'EL')).toMatchObject({ accrued: 1.25, balance: 1.25 });
    const bCl = (await balance(p.b, 'CL'))!;
    expect(bCl.balance).toBe(0.5);
    expect(bCl.entries[0]).toMatchObject({
      kind: 'accrual',
      days: 0.5,
      note: 'March accrual: 16 of 31 days (joined 16 Mar)',
    });
    expect((await balance(p.b, 'EL'))!.balance).toBe(0);
    expect((await balances(p.c, 2026)).map((b) => b.leaveType.code)).toEqual([
      'CL',
      'SL',
      'CO',
      'ML',
      'PTL',
      'BL',
      'LOP',
    ]);
    expect(await balances(p.d, 2026)).toEqual([]);
  });
});

describe('cut-over import (done-when #2)', () => {
  const csv = (rows: string[]) => ['employee_code,leave_type,balance', ...rows].join('\n');
  const good = () =>
    csv([`${p.a.employeeCode},CL,5`, `${p.a.employeeCode},el,10.5`, `${p.b.employeeCode},SL,2`]);

  it('checks first and applies nothing while any row is wrong', async () => {
    const bad = (
      await agents
        .hr!.post('/api/leave/balances/import', {
          csv: csv([
            `${p.a.employeeCode},CL,5`,
            'IDS-9999,CL,1',
            `${p.b.employeeCode},XX,1`,
            `${p.b.employeeCode},SL,1.3`,
          ]),
          asOf: '2026-03-31',
          commit: true,
        })
        .expect(200)
    ).body as LeaveImportResult;
    expect(bad.committed).toBe(false);
    expect(bad.errors.map((e) => e.line)).toEqual([3, 4, 5]);
    expect((await balance(p.a, 'CL'))!.balance).toBe(1);
    await agents
      .mgr!.post('/api/leave/balances/import', { csv: good(), asOf: '2026-03-31', commit: false })
      .expect(403);
  });

  it('sets every balance to the source, and applying again changes nothing', async () => {
    const check = (
      await agents
        .hr!.post('/api/leave/balances/import', { csv: good(), asOf: '2026-03-31', commit: false })
        .expect(200)
    ).body as LeaveImportResult;
    expect(check).toMatchObject({ committed: false, rows: 3, errors: [] });
    expect(check.changes).toEqual([
      { line: 2, employeeCode: p.a.employeeCode, leaveType: 'CL', from: 1, to: 5 },
      { line: 3, employeeCode: p.a.employeeCode, leaveType: 'EL', from: 1.25, to: 10.5 },
      { line: 4, employeeCode: p.b.employeeCode, leaveType: 'SL', from: 0.5, to: 2 },
    ]);
    expect((await balance(p.a, 'CL'))!.balance).toBe(1);
    const done = (
      await agents
        .hr!.post('/api/leave/balances/import', { csv: good(), asOf: '2026-03-31', commit: true })
        .expect(200)
    ).body as LeaveImportResult;
    expect(done.committed).toBe(true);
    // Every imported balance matches the source.
    expect((await balance(p.a, 'CL'))!.balance).toBe(5);
    expect((await balance(p.a, 'EL'))!.balance).toBe(10.5);
    expect((await balance(p.b, 'SL'))!.balance).toBe(2);
    expect((await balance(p.a, 'CL'))!.entries.at(-1)).toMatchObject({
      kind: 'opening',
      days: 4,
      note: 'Imported balance as of 2026-03-31',
    });
    const again = (
      await agents
        .hr!.post('/api/leave/balances/import', { csv: good(), asOf: '2026-03-31', commit: true })
        .expect(200)
    ).body as LeaveImportResult;
    expect(again.changes).toEqual([]);
  });

  it('months up to the import are not credited again; later ones are', async () => {
    await run((s) => s.accrueMonth('2026-02'));
    expect((await balance(p.a, 'CL'))!.balance).toBe(5);
    // A's SL wasn't imported, so February is credited for it.
    expect((await balance(p.a, 'SL'))!.balance).toBe(2);
    await run((s) => s.accrueMonth('2026-04'));
    expect((await balance(p.a, 'CL'))!.balance).toBe(6);
    expect((await balance(p.a, 'EL'))!.balance).toBe(11.75);
  });
});

describe('caps and year end', () => {
  it('accrual stops at the maximum balance, and says so', async () => {
    const cl = (
      (await agents.admin!.get('/api/leave-types').expect(200)).body as LeaveTypeView[]
    ).find((t) => t.code === 'CL')!;
    const { id, sortOrder: _s, ...body } = cl;
    await agents.admin!.put(`/api/leave-types/${id}`, { ...body, maxBalance: 6.5 }).expect(200);
    await run((s) => s.accrueMonth('2026-05'));
    const after = (await balance(p.a, 'CL'))!;
    expect(after.balance).toBe(6.5);
    expect(after.entries.at(-1)!.note).toBe('May accrual: 31 of 31 days; capped at 6.5 days');
    await agents.admin!.put(`/api/leave-types/${id}`, { ...body, maxBalance: null }).expect(200);
  });

  it('casual and sick lapse; earned carries up to 30; running twice changes nothing', async () => {
    const before = {
      cl: (await balance(p.a, 'CL'))!.balance,
      el: (await balance(p.a, 'EL'))!.balance,
    };
    await run((s) => s.closeYear(2026));
    await run((s) => s.closeYear(2026));
    const cl = (await balance(p.a, 'CL'))!;
    expect(cl.balance).toBe(0);
    expect(cl.lapsed).toBe(before.cl);
    expect(cl.entries.at(-1)!.note).toBe('Year end: Casual leave doesn’t carry forward');
    const el2027 = (await balance(p.a, 'EL', 2027))!;
    expect(el2027).toMatchObject({ opening: before.el, balance: before.el });
    expect((await balance(p.a, 'CL', 2027))!.balance).toBe(0);
  });
});

describe('HR adjustments and who sees balances', () => {
  const year = Number(businessDate(new Date()).slice(0, 4));

  it('HR adjusts with a reason; never below zero unless the type allows it', async () => {
    const sl = (await balance(p.c, 'SL', year))!;
    const res = await agents
      .hr!.post(`/api/people/${p.c.personId}/leave/adjustments`, {
        leaveTypeId: sl.leaveType.id,
        days: 1.5,
        reason: 'Correction agreed with the manager',
      })
      .expect(201);
    expect((res.body as LeaveBalanceView).balance).toBe(sl.balance + 1.5);
    await agents
      .hr!.post(`/api/people/${p.c.personId}/leave/adjustments`, {
        leaveTypeId: sl.leaveType.id,
        days: -100,
        reason: 'Too much',
      })
      .expect(400);
    await agents
      .hr!.post(`/api/people/${p.c.personId}/leave/adjustments`, {
        leaveTypeId: sl.leaveType.id,
        days: 0.3,
        reason: 'Not a half day',
      })
      .expect(400);
    await agents
      .hr!.post(`/api/people/${p.c.personId}/leave/adjustments`, {
        leaveTypeId: sl.leaveType.id,
        days: 1,
      })
      .expect(400);
    await agents
      .mgr!.post(`/api/people/${p.a.personId}/leave/adjustments`, {
        leaveTypeId: sl.leaveType.id,
        days: 1,
        reason: 'Manager tries',
      })
      .expect(403);
    const audit = await pool.query(
      `select count(*)::int as n from audit_log where table_name = 'leave_ledger_entry' and subject_person_id = $1`,
      [p.c.personId],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('people see their own balances and managers their team’s; not colleagues or CXO', async () => {
    await balances(p.a, 2026, agents.emp!);
    await balances(p.a, 2026, agents.mgr!);
    await agents.other!.get(`/api/people/${p.a.personId}/leave?year=2026`).expect(403);
    await agents.cxo!.get(`/api/people/${p.a.personId}/leave?year=2026`).expect(403);
  });
});

describe('the daily job (decision #73)', () => {
  it('credits casual and sick at the start of the month, earned at its end; joiners the next day', async () => {
    const cl = (await balance(p.a, 'CL'))!;
    await run((s) => s.runDaily('2026-06-01'));
    // June's casual and sick leave are there on 1 June; June's earned leave is not, May's is.
    const after = (await balance(p.a, 'CL'))!;
    expect(after.entries.find((e) => e.note?.startsWith('June accrual'))).toMatchObject({
      days: 1,
      date: '2026-06-30',
    });
    expect(after.balance).toBe(cl.balance + 1);
    const el = (await balance(p.a, 'EL'))!;
    expect(el.entries.some((e) => e.note?.startsWith('May accrual'))).toBe(true);
    expect(el.entries.some((e) => e.note?.startsWith('June accrual'))).toBe(false);

    // Joined 10 June: credited the next morning, 21 of 30 days of 1 = 0.7 → 0.5.
    const e = await hire('Esha Joiner', 'permanent', '2026-06-10');
    await run((s) => s.runDaily('2026-06-11'));
    expect((await balance(e, 'CL'))!.entries[0]).toMatchObject({
      days: 0.5,
      note: 'June accrual: 21 of 30 days (joined 10 Jun)',
    });
    await run((s) => s.runDaily('2026-06-12'));
    expect((await balance(e, 'CL'))!.balance).toBe(0.5);
  });

  it('in January credits December and the month before, then closes the year', async () => {
    const result = await run((s) => s.runDaily('2027-01-01'));
    expect(result.closedYear).toBe(2026);
    // A December credit happened before closing: A's 2026 EL carried includes it.
    const el2026 = (await balance(p.a, 'EL'))!;
    expect(el2026.entries.some((e) => e.note?.startsWith('December accrual'))).toBe(true);
  });
});
