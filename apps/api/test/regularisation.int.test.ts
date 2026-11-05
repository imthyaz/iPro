import type { INestApplication } from '@nestjs/common';
import type {
  ApprovalCard,
  AttendanceDayView,
  AttendanceExceptionView,
  RegularisationAllowance,
  RegularisationView,
} from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttendanceService } from '../src/attendance/attendance.service.js';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only. Dates are relative to today, since the window is counted from today.
const U = {
  admin: '00000000-0000-4000-8000-000000603001',
  hr: '00000000-0000-4000-8000-000000603002',
  mgr: '00000000-0000-4000-8000-000000603003',
  emp: '00000000-0000-4000-8000-000000603004',
  other: '00000000-0000-4000-8000-000000603005',
  cxo: '00000000-0000-4000-8000-000000603006',
};
const email = (id: string) => `${id}@test.ipro.test`;
const today = businessDate(new Date());
const d1 = addDays(today, -1);
const d2 = addDays(today, -2);
const old = addDays(today, -7);

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const people: Record<'mgr' | 'emp' | 'other', { personId: string; engagementId: string }> =
  {} as never;
const agents: Record<string, ReturnType<typeof as>> = {};

const build = (day: string) =>
  runWithContext({ tenantId: tenant }, () =>
    app.get(AttendanceService).buildDay(day, new Date(`${addDays(day, 1)}T02:00:00+05:30`)),
  );
const dayOf = async (who: 'emp' | 'other', date: string) =>
  (
    (
      await agents
        .hr!.get(`/api/people/${people[who].personId}/attendance?month=${date.slice(0, 7)}`)
        .expect(200)
    ).body as AttendanceDayView[]
  ).find((d) => d.date === date)!;
const mine = async (month: string) =>
  (await agents.emp!.get(`/api/attendance/regularisations?month=${month}`).expect(200)).body as {
    allowance: RegularisationAllowance;
    items: RegularisationView[];
  };
const cardFor = async (who: string) =>
  ((await agents[who]!.get('/api/approvals').expect(200)).body as ApprovalCard[]).find(
    (c) => c.subject.personId === people.emp.personId,
  );
const setMax = (n: number) =>
  pool.query(
    `insert into tenant_setting (tenant_id, key, value) values ($1, 'regularisation_max_per_month', $2::jsonb)
     on conflict (tenant_id, key) do update set value = excluded.value`,
    [tenant, JSON.stringify(n)],
  );

async function hire(name: string, userId: string, managerEngagementId?: string) {
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
  return res.body as { personId: string; engagementId: string };
}

beforeAll(async () => {
  tenant = await newTenant(pool, 'Regularisation tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Rg Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Rg HR', ['employee', 'hr']);
  await addUser(db, tenant, U.mgr, 'Rg Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.emp, 'Rg Employee', ['employee']);
  await addUser(db, tenant, U.other, 'Rg Other', ['employee']);
  await addUser(db, tenant, U.cxo, 'Rg CXO', ['employee', 'cxo']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  people.mgr = await hire('Rani Manager', U.mgr);
  people.emp = await hire('Ravi Employee', U.emp, people.mgr.engagementId);
  people.other = await hire('Rekha Other', U.other);
  // Every day a working day, all day long, so the tests don't depend on the weekday or the hour.
  const shift = await agents
    .admin!.post('/api/shifts', {
      code: 'ALLDAY',
      name: 'All week',
      startTime: '00:00',
      endTime: '23:59',
      graceMinutes: 0,
      breakMinutes: 60,
      weeklyOffs: [],
    })
    .expect(201);
  await agents
    .hr!.post('/api/shifts/allocations', {
      personIds: [people.emp.personId, people.other.personId],
      shiftId: shift.body.id,
      effectiveFrom: '2024-01-08',
      reason: 'Test shift',
    })
    .expect(201);
  for (const day of [old, d2, d1]) await build(day);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('regularisation by the employee (spec workflow 5; decision #69)', () => {
  let requestId: string;

  it('asks to correct an absent day; the manager decides on the card', async () => {
    expect((await dayOf('emp', d1)).status).toBe('absent');
    expect((await mine(d1.slice(0, 7))).allowance).toMatchObject({
      used: 0,
      max: 3,
      windowDays: 5,
    });

    const asked = (
      await agents
        .emp!.post('/api/attendance/regularisations', {
          date: d1,
          reason: 'forgot_to_punch',
          status: 'present',
          firstIn: '09:30',
          lastOut: '18:30',
          note: 'Card reader was down',
        })
        .expect(201)
    ).body as RegularisationView;
    expect(asked).toMatchObject({ date: d1, state: 'pending', source: 'employee' });
    requestId = asked.requestId!;
    await agents
      .emp!.post('/api/attendance/regularisations', {
        date: d1,
        reason: 'forgot_to_punch',
        status: 'present',
      })
      .expect(409);

    // Nothing changes before approval; HR doesn't approve, the manager does.
    expect((await dayOf('emp', d1)).status).toBe('absent');
    expect(await cardFor('hr')).toBeUndefined();
    const card = (await cardFor('mgr'))!;
    expect(card.stepLabel).toBe('Manager approval');
    expect(card.changes).toEqual(
      expect.arrayContaining([
        { label: 'Status', from: 'Absent', to: 'Present' },
        { label: 'Times', from: null, to: '09:30–18:30' },
        { label: 'Reason', from: null, to: 'Forgot to punch: Card reader was down' },
        { label: 'Regularisations this month', from: null, to: '1 of 3' },
      ]),
    );
    await agents.mgr!.post(`/api/approvals/${card.approvalId}/approve`, {}).expect(201);

    expect(await dayOf('emp', d1)).toMatchObject({
      status: 'present',
      regularised: true,
      firstIn: `${d1}T04:00:00.000Z`,
      workedMinutes: 8 * 60,
      flags: [],
    });
    expect((await mine(d1.slice(0, 7))).items[0]).toMatchObject({ state: 'approved' });
    const events = await pool.query(
      `select count(*)::int as n from journal_event where person_id = $1 and event_type = 'attendance_regularised'`,
      [people.emp.personId],
    );
    expect(events.rows[0].n).toBe(1);
  });

  it('a regularised day is not rebuilt over', async () => {
    await build(d1);
    expect((await dayOf('emp', d1)).status).toBe('present');
  });

  it('a returned request can be withdrawn, and then no longer counts', async () => {
    const asked = (
      await agents
        .emp!.post('/api/attendance/regularisations', {
          date: d2,
          reason: 'on_duty',
          status: 'client_site',
        })
        .expect(201)
    ).body as RegularisationView;
    const card = (await cardFor('mgr'))!;
    await agents
      .mgr!.post(`/api/approvals/${card.approvalId}/reject`, { comment: 'Which client?' })
      .expect(201);
    const returned = (await mine(d2.slice(0, 7))).items.find((i) => i.id === asked.id)!;
    expect(returned.state).toBe('returned');
    await agents.emp!.post(`/api/workflows/${asked.requestId}/withdraw`, {}).expect(201);
    const after = await mine(d2.slice(0, 7));
    expect(after.items.find((i) => i.id === asked.id)!.state).toBe('withdrawn');
    expect((await dayOf('emp', d2)).status).toBe('absent');
    expect(requestId).toBeTruthy();
  });

  it('refuses today, days outside the window, a regularised day, and over the monthly limit', async () => {
    const ask = (date: string) =>
      agents.emp!.post('/api/attendance/regularisations', {
        date,
        reason: 'system_issue',
        status: 'present',
      });
    await ask(today).expect(400);
    expect((await ask(old).expect(400)).body.message).toMatch(/up to 5 days/);
    await ask(d1).expect(409);
    await setMax(0);
    expect((await ask(d2).expect(400)).body.message).toMatch(/used all 0/);
    await setMax(3);
    await agents.emp!.post('/api/attendance/regularisations', { date: d2 }).expect(400);
  });
});

describe('HR: exceptions and direct corrections (H9)', () => {
  it('HR sees exceptions for everyone; a manager for their team; CXO no one’s days', async () => {
    const forHr = (
      await agents.hr!.get(`/api/attendance/exceptions?from=${old}&to=${d1}`).expect(200)
    ).body as AttendanceExceptionView[];
    expect(forHr).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ personId: people.emp.personId, date: old, status: 'absent' }),
        expect.objectContaining({ personId: people.other.personId, date: d1, status: 'absent' }),
      ]),
    );
    // The regularised day is no longer an exception.
    expect(forHr.find((e) => e.personId === people.emp.personId && e.date === d1)).toBeUndefined();
    const forMgr = (
      await agents.mgr!.get(`/api/attendance/exceptions?from=${old}&to=${d1}`).expect(200)
    ).body as AttendanceExceptionView[];
    expect(new Set(forMgr.map((e) => e.personId))).toEqual(new Set([people.emp.personId]));
    await agents.cxo!.get(`/api/attendance/exceptions?from=${old}&to=${d1}`).expect(403);
    await agents
      .cxo!.get(`/api/people/${people.emp.personId}/attendance?month=${d1.slice(0, 7)}`)
      .expect(403);
    await agents.emp!.get(`/api/attendance/exceptions?from=${old}&to=${d1}`).expect(403);
    await agents
      .hr!.get(`/api/attendance/exceptions?from=${addDays(today, -90)}&to=${today}`)
      .expect(400);
  });

  it('HR corrects several days at once with a reason, overtaking an open request', async () => {
    const open = (
      await agents
        .emp!.post('/api/attendance/regularisations', {
          date: d2,
          reason: 'forgot_to_punch',
          status: 'present',
        })
        .expect(201)
    ).body as RegularisationView;
    await agents
      .mgr!.post('/api/attendance/corrections', {
        days: [{ personId: people.emp.personId, date: d2 }],
        status: 'present',
        reason: 'Manager says so',
      })
      .expect(403);
    await agents
      .hr!.post('/api/attendance/corrections', {
        days: [{ personId: people.emp.personId, date: d2 }],
        status: 'present',
      })
      .expect(400);
    const res = await agents
      .hr!.post('/api/attendance/corrections', {
        days: [
          { personId: people.emp.personId, date: d2 },
          { personId: people.other.personId, date: d1 },
          { personId: people.other.personId, date: d2 },
        ],
        status: 'wfh',
        reason: 'Approved WFH during the office network outage',
      })
      .expect(201);
    expect(res.body).toEqual({ corrected: 3 });
    expect(await dayOf('other', d1)).toMatchObject({ status: 'wfh', regularised: true });
    expect(await dayOf('emp', d2)).toMatchObject({ status: 'wfh', regularised: true });
    expect((await mine(d2.slice(0, 7))).items.find((i) => i.id === open.id)!.state).toBe(
      'withdrawn',
    );
    expect(await cardFor('mgr')).toBeUndefined();
    const audit = await pool.query(
      `select count(*)::int as n from audit_log where table_name = 'attendance_day' and subject_person_id = $1`,
      [people.other.personId],
    );
    expect(audit.rows[0].n).toBe(2);
    await agents
      .hr!.post('/api/attendance/corrections', {
        days: [{ personId: people.other.personId, date: addDays(today, 1) }],
        status: 'present',
        reason: 'Future',
      })
      .expect(400);
  });
});

describe('missing check-in reminder (spec notifications)', () => {
  it('reminds once a day those who haven’t checked in on a working day', async () => {
    await agents.emp!.post('/api/attendance/check-in', { mode: 'wfh', device: 'web' }).expect(201);
    const remind = () =>
      runWithContext({ tenantId: tenant }, () =>
        app.get(AttendanceService).remindMissingCheckIns(),
      );
    await remind();
    await remind();
    const sent = await pool.query(
      `select recipient_user_id as who, count(*)::int as n from notification
       where kind = 'missing_check_in' and tenant_id = $1 group by recipient_user_id`,
      [tenant],
    );
    const byUser = new Map(sent.rows.map((r) => [r.who, r.n]));
    expect(byUser.get(U.other)).toBe(1);
    expect(byUser.get(U.emp)).toBeUndefined();
  });
});
