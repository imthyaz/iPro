import type { INestApplication } from '@nestjs/common';
import type {
  ApprovalCard,
  AttendanceDayView,
  LeaveBalanceView,
  LeavePreview,
  LeaveRequestView,
  LeaveTypeView,
} from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only. Dates are relative to today: leave can be applied 5 days back at most.
const U = {
  admin: '00000000-0000-4000-8000-000000605001',
  hr: '00000000-0000-4000-8000-000000605002',
  boss: '00000000-0000-4000-8000-000000605003',
  mgr: '00000000-0000-4000-8000-000000605004',
  emp: '00000000-0000-4000-8000-000000605005',
  mate: '00000000-0000-4000-8000-000000605006',
  cxo: '00000000-0000-4000-8000-000000605007',
};
const email = (id: string) => `${id}@test.ipro.test`;
const today = businessDate(new Date());
const d = (n: number) => addDays(today, n);

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const agents: Record<string, ReturnType<typeof as>> = {};
type Hire = { personId: string; engagementId: string; employeeCode: string };
const p = {} as Record<'boss' | 'mgr' | 'emp' | 'mate', Hire>;
let types: LeaveTypeView[];
const typeId = (code: string) => types.find((t) => t.code === code)!.id;

const apply = (who: string, body: object) => agents[who]!.post('/api/leave/requests', body);
const preview = async (who: string, body: object) =>
  (await agents[who]!.post('/api/leave/requests/preview', body).expect(200)).body as LeavePreview;
const cards = async (who: string) =>
  (await agents[who]!.get('/api/approvals').expect(200)).body as ApprovalCard[];
const cardOf = async (who: string, personId: string) =>
  (await cards(who)).find((c) => c.subject.personId === personId);
const approve = async (who: string, personId: string) => {
  const card = (await cardOf(who, personId))!;
  await agents[who]!.post(`/api/approvals/${card.approvalId}/approve`, {}).expect(201);
};
const balance = async (who: Hire, code: string, year = Number(today.slice(0, 4))) =>
  (
    (await agents.hr!.get(`/api/people/${who.personId}/leave?year=${year}`).expect(200))
      .body as LeaveBalanceView[]
  ).find((b) => b.leaveType.code === code)!.balance;
const dayOf = async (who: Hire, date: string) =>
  (
    (
      await agents
        .hr!.get(`/api/people/${who.personId}/attendance?month=${date.slice(0, 7)}`)
        .expect(200)
    ).body as AttendanceDayView[]
  ).find((x) => x.date === date)!;
const mine = async (who: string) =>
  (await agents[who]!.get(`/api/leave/requests/mine?year=${today.slice(0, 4)}`).expect(200))
    .body as LeaveRequestView[];

async function hire(name: string, userId: string, managerEngagementId?: string): Promise<Hire> {
  const res = await agents
    .hr!.post('/api/people', {
      person: { legalName: name },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        workEmail: email(userId),
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
  return res.body;
}

/** Sets balances as of a date in the leave's year (the cut-over import). */
async function setBalances(rows: [Hire, string, number][], asOf: string) {
  const csv = [
    'employee_code,leave_type,balance',
    ...rows.map(([h, code, n]) => `${h.employeeCode},${code},${n}`),
  ].join('\n');
  await agents.hr!.post('/api/leave/balances/import', { csv, asOf, commit: true }).expect(200);
}

beforeAll(async () => {
  tenant = await newTenant(pool, 'Leave request tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Lr Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Lr HR', ['employee', 'hr']);
  await addUser(db, tenant, U.boss, 'Lr Boss', ['employee', 'manager']);
  await addUser(db, tenant, U.mgr, 'Lr Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.emp, 'Lr Employee', ['employee']);
  await addUser(db, tenant, U.mate, 'Lr Mate', ['employee']);
  await addUser(db, tenant, U.cxo, 'Lr CXO', ['employee', 'cxo']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  p.boss = await hire('Bharat Boss', U.boss);
  p.mgr = await hire('Meena Manager', U.mgr, p.boss.engagementId);
  p.emp = await hire('Esha Employee', U.emp, p.mgr.engagementId);
  p.mate = await hire('Mohan Mate', U.mate, p.mgr.engagementId);
  // Esha is confirmed; Mohan is still on probation.
  await pool.query(`update engagement set confirmation_date = '2024-07-08' where id = $1`, [
    p.emp.engagementId,
  ]);
  await pool.query(`update engagement set confirmation_date = null where id = $1`, [
    p.mate.engagementId,
  ]);
  // Every day a working day, so the tests don't depend on the weekday (weekends: unit tests).
  const shift = await agents
    .admin!.post('/api/shifts', {
      code: 'ALLDAY',
      name: 'All week',
      startTime: '00:00',
      endTime: '23:59',
      graceMinutes: 0,
      weeklyOffs: [],
    })
    .expect(201);
  await agents
    .hr!.post('/api/shifts/allocations', {
      personIds: [p.emp.personId, p.mate.personId],
      shiftId: shift.body.id,
      effectiveFrom: '2024-01-08',
      reason: 'Test shift',
    })
    .expect(201);
  types = (await agents.emp!.get('/api/leave-types').expect(200)).body;
  await setBalances(
    [
      [p.emp, 'CL', 3],
      [p.emp, 'SL', 5],
      [p.mate, 'CL', 2],
    ],
    d(-6),
  );
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('applying (E4; spec workflow 4, decision #74)', () => {
  it('shows the balance after before sending, and offers loss of pay for a shortfall', async () => {
    const fits = await preview('emp', { leaveTypeId: typeId('CL'), from: d(7), to: d(9) });
    expect(fits).toMatchObject({
      days: 3,
      fromType: 3,
      lop: 0,
      balanceBefore: 3,
      balanceAfter: 0,
      shortfall: 0,
      unplanned: false,
      needsSecondApproval: false,
      problems: [],
    });
    const short = await preview('emp', { leaveTypeId: typeId('CL'), from: d(7), to: d(10) });
    expect(short).toMatchObject({ days: 4, fromType: 3, lop: 1, shortfall: 1 });
    expect(short.problems[0]).toBe('You have 3 days of Casual leave; 1 day would be loss of pay');
    const refused = await apply('emp', { leaveTypeId: typeId('CL'), from: d(7), to: d(10) }).expect(
      400,
    );
    expect(refused.body).toMatchObject({ shortfall: 1 });
  });

  it('sends with the shortfall as loss of pay; the manager decides on the card', async () => {
    const sent = (
      await apply('emp', {
        leaveTypeId: typeId('CL'),
        from: d(7),
        to: d(10),
        reason: 'Family wedding',
        lopForShortfall: true,
      }).expect(201)
    ).body as LeaveRequestView;
    expect(sent).toMatchObject({ status: 'applied', days: 4, lop: 1, canCancel: true });
    // Asked-for leave is held: the balance shows it, and nothing more can be asked against it.
    expect(
      (await preview('emp', { leaveTypeId: typeId('CL'), from: d(30), to: d(30) })).balanceBefore,
    ).toBe(0);
    // Not debited, nor on the calendar as leave, until approved.
    expect(await balance(p.emp, 'CL')).toBe(3);
    expect((await dayOf(p.emp, d(7))).leave).toMatchObject({ code: 'CL', approved: false });

    expect(await cardOf('hr', p.emp.personId)).toBeUndefined();
    const card = (await cardOf('mgr', p.emp.personId))!;
    expect(card.stepLabel).toBe('Manager approval');
    expect(card.changes).toEqual(
      expect.arrayContaining([
        { label: 'Casual leave balance', from: '3', to: '0' },
        { label: 'Loss of pay', from: null, to: '1 day' },
        { label: 'Also off', from: null, to: 'No one else in the team (2 people)' },
        { label: 'Policy', from: null, to: 'Planned, 7 days ahead · Reason: Family wedding' },
      ]),
    );
    await approve('mgr', p.emp.personId);
    expect(await balance(p.emp, 'CL')).toBe(0);
    expect((await mine('emp'))[0]!.status).toBe('approved');
    const day = await dayOf(p.emp, d(7));
    expect(day).toMatchObject({
      status: 'leave',
      leave: { code: 'CL', half: 'full', approved: true },
    });
    expect((await dayOf(p.emp, d(10))).leave).toMatchObject({ code: 'LOP', approved: true });
    const events = await pool.query(
      `select title from journal_event where person_id = $1 and event_type = 'leave_approved'`,
      [p.emp.personId],
    );
    expect(events.rows).toHaveLength(1);
  });

  it('refuses overlaps, probation-only types, old dates, and too much per-request leave', async () => {
    expect(
      (await apply('emp', { leaveTypeId: typeId('LOP'), from: d(8), to: d(8) }).expect(400)).body
        .message,
    ).toMatch(/already have leave/);
    // The other half of a half day is fine.
    expect(
      (
        await preview('emp', {
          leaveTypeId: typeId('LOP'),
          from: d(11),
          to: d(11),
          endHalf: 'first',
        })
      ).problems,
    ).toEqual([]);
    expect(
      (await apply('mate', { leaveTypeId: typeId('EL'), from: d(14), to: d(14) }).expect(400)).body
        .message,
    ).toBe('Earned leave can’t be taken during probation');
    expect(
      (await apply('emp', { leaveTypeId: typeId('LOP'), from: d(-6), to: d(-6) }).expect(400)).body
        .message,
    ).toMatch(/up to 5 days back/);
    expect(
      (await apply('emp', { leaveTypeId: typeId('BL'), from: d(40), to: d(43) }).expect(400)).body
        .message,
    ).toBe('Bereavement leave is up to 3 days a request');
  });

  it('the team sees who else is off on the card', async () => {
    await apply('mate', { leaveTypeId: typeId('CL'), from: d(8), to: d(8) }).expect(201);
    const card = (await cardOf('mgr', p.mate.personId))!;
    expect(card.changes.find((c) => c.label === 'Also off')!.to).toMatch(
      /^1 of 2: Esha Employee \(/,
    );
    // Withdrawn by the person before a decision: the card goes and the days are free again.
    const [req] = await mine('mate');
    await agents.mate!.post(`/api/leave/requests/${req!.id}/cancel`).expect(200);
    expect((await mine('mate'))[0]!.status).toBe('withdrawn');
    expect(await cardOf('mgr', p.mate.personId)).toBeUndefined();
    expect(await balance(p.mate, 'CL')).toBe(2);
  });
});

describe('second approval and cancelling', () => {
  it('leave over 5 days goes to the manager, then the manager’s manager', async () => {
    const sent = (
      await apply('emp', { leaveTypeId: typeId('LOP'), from: d(20), to: d(25) }).expect(201)
    ).body as LeaveRequestView;
    await approve('mgr', p.emp.personId);
    expect((await mine('emp')).find((r) => r.id === sent.id)!.status).toBe('applied');
    const second = (await cardOf('boss', p.emp.personId))!;
    expect(second.stepLabel).toBe('Second approval (long leave)');
    await approve('boss', p.emp.personId);
    expect((await mine('emp')).find((r) => r.id === sent.id)!.status).toBe('approved');
  });

  it('approved leave is cancelled before it starts, giving the days back', async () => {
    const cl = (await mine('emp')).find((r) => r.leaveType.code === 'CL')!;
    await agents.mate!.post(`/api/leave/requests/${cl.id}/cancel`).expect(403);
    const done = (await agents.emp!.post(`/api/leave/requests/${cl.id}/cancel`).expect(200))
      .body as LeaveRequestView;
    expect(done.status).toBe('cancelled');
    expect(await balance(p.emp, 'CL')).toBe(3);
    expect((await dayOf(p.emp, d(7))).leave).toBeNull();
  });
});

describe('started leave: unplanned, revoked by HR', () => {
  let started: LeaveRequestView;

  it('back-dated leave is unplanned and marks past days as leave on approval', async () => {
    started = (await apply('emp', { leaveTypeId: typeId('CL'), from: d(-2), to: d(0) }).expect(201))
      .body as LeaveRequestView;
    expect(started).toMatchObject({ unplanned: true, days: 3 });
    const card = (await cardOf('mgr', p.emp.personId))!;
    expect(card.changes.find((c) => c.label === 'Policy')!.to).toBe(
      'Unplanned: applied on or after the first day',
    );
    await approve('mgr', p.emp.personId);
    expect((await dayOf(p.emp, d(-2))).status).toBe('leave');
    expect((await dayOf(p.emp, d(-1))).status).toBe('leave');
    // Started: the employee can't cancel it any more.
    await agents.emp!.post(`/api/leave/requests/${started.id}/cancel`).expect(400);
  });

  it('HR gives back the days from today with a reason; the manager can’t', async () => {
    await agents
      .mgr!.post(`/api/leave/requests/${started.id}/revoke`, { from: today, reason: 'Back early' })
      .expect(403);
    await agents
      .hr!.post(`/api/leave/requests/${started.id}/revoke`, { from: d(5), reason: 'Out of range' })
      .expect(400);
    const before = await balance(p.emp, 'CL');
    const done = (
      await agents
        .hr!.post(`/api/leave/requests/${started.id}/revoke`, {
          from: today,
          reason: 'Came back early',
        })
        .expect(200)
    ).body as LeaveRequestView;
    expect(done).toMatchObject({ status: 'approved', revokedFrom: today });
    expect(await balance(p.emp, 'CL')).toBe(before + 1);
    expect((await dayOf(p.emp, d(-1))).status).toBe('leave');
    expect((await dayOf(p.emp, today)).status).not.toBe('leave');
    expect((await dayOf(p.emp, today)).leave).toBeNull();
  });
});

describe('certificates and who sees requests', () => {
  it('sick leave over 2 days waits for a certificate (decision #75); it is kept confidential', async () => {
    const sent = (
      await apply('emp', { leaveTypeId: typeId('SL'), from: d(50), to: d(52) }).expect(201)
    ).body as LeaveRequestView;
    expect(sent).toMatchObject({ needsCertificate: true, certificateAttached: false });
    let card = (await cardOf('mgr', p.emp.personId))!;
    expect(card.changes.find((c) => c.label === 'Policy')!.to).toMatch(
      /Medical certificate needed: approval waits for it/,
    );
    // Approval waits; returning it is still possible.
    expect(card.waitingFor).toBe('Waiting for the medical certificate');
    const refused = await agents
      .mgr!.post(`/api/approvals/${card.approvalId}/approve`, {})
      .expect(409);
    expect(refused.body.message).toBe('Waiting for the medical certificate');
    expect((await mine('emp')).find((r) => r.id === sent.id)!.status).toBe('applied');
    const attached = await agents
      .emp!.post(`/api/leave/requests/${sent.id}/certificate`)
      .attach('file', Buffer.from('%PDF-1.4\n% synthetic certificate\n'), {
        filename: 'cert.pdf',
        contentType: 'application/pdf',
      })
      .expect(200);
    expect(attached.body.certificateAttached).toBe(true);
    card = (await cardOf('mgr', p.emp.personId))!;
    expect(card.changes.find((c) => c.label === 'Policy')!.to).toMatch(
      /Medical certificate attached/,
    );
    expect(card.waitingFor).toBeNull();
    await agents.mgr!.post(`/api/approvals/${card.approvalId}/approve`, {}).expect(201);
    expect((await mine('emp')).find((r) => r.id === sent.id)!.status).toBe('approved');
    const docs = await pool.query(
      `select type, confidential from document where person_id = $1 and type = 'certificate'`,
      [p.emp.personId],
    );
    expect(docs.rows).toEqual([{ type: 'certificate', confidential: true }]);
  });

  it('HR and the manager see a person’s requests; colleagues and CXO don’t', async () => {
    const path = `/api/people/${p.emp.personId}/leave/requests?year=${today.slice(0, 4)}`;
    expect((await agents.hr!.get(path).expect(200)).body.length).toBeGreaterThan(0);
    await agents.mgr!.get(path).expect(200);
    await agents.mate!.get(path).expect(403);
    await agents.cxo!.get(path).expect(403);
  });
});
