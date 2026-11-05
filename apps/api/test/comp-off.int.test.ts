import type { INestApplication } from '@nestjs/common';
import type {
  ApprovalCard,
  CompOffRequestView,
  LeaveBalanceView,
  LeavePreview,
  LeaveTypeView,
} from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { CompOffService } from '../src/leave/comp-off.service.js';
import { LeaveService } from '../src/leave/leave.service.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only. Dates are relative to today; the shift makes only today's weekday a
// working day, so the six days before today are weekly offs.
const U = {
  admin: '00000000-0000-4000-8000-000000606001',
  hr: '00000000-0000-4000-8000-000000606002',
  mgr: '00000000-0000-4000-8000-000000606003',
  emp: '00000000-0000-4000-8000-000000606004',
  mate: '00000000-0000-4000-8000-000000606005',
};
const email = (id: string) => `${id}@test.ipro.test`;
const today = businessDate(new Date());
const d = (n: number) => addDays(today, n);
const isoWeekday = (iso: string) => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const agents: Record<string, ReturnType<typeof as>> = {};
type Hire = { personId: string; engagementId: string; employeeCode: string };
const p = {} as Record<'mgr' | 'emp' | 'mate', Hire>;
let types: LeaveTypeView[];
const typeId = (code: string) => types.find((t) => t.code === code)!.id;

const ask = (who: string, body: object) => agents[who]!.post('/api/leave/comp-off', body);
const mine = async (who: string) =>
  (await agents[who]!.get(`/api/leave/comp-off/mine?year=${today.slice(0, 4)}`).expect(200))
    .body as CompOffRequestView[];
const cardOf = async (who: string, personId: string) =>
  ((await agents[who]!.get('/api/approvals').expect(200)).body as ApprovalCard[]).find(
    (c) => c.subject.personId === personId && c.title.startsWith('Comp-off'),
  );
const approve = async (who: string, personId: string) => {
  const card = (await cardOf(who, personId))!;
  await agents[who]!.post(`/api/approvals/${card.approvalId}/approve`, {}).expect(201);
};
const coBalance = async (who: Hire, year = Number(today.slice(0, 4))) =>
  (
    (await agents.hr!.get(`/api/people/${who.personId}/leave?year=${year}`).expect(200))
      .body as LeaveBalanceView[]
  ).find((b) => b.leaveType.code === 'CO')!;
const expire = (on: string) =>
  runWithContext({ tenantId: tenant }, () => app.get(CompOffService).expire(on));

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

beforeAll(async () => {
  tenant = await newTenant(pool, 'Comp-off tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Co Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Co HR', ['employee', 'hr']);
  await addUser(db, tenant, U.mgr, 'Co Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.emp, 'Co Employee', ['employee']);
  await addUser(db, tenant, U.mate, 'Co Mate', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  p.mgr = await hire('Mala Manager', U.mgr);
  p.emp = await hire('Ezhil Employee', U.emp, p.mgr.engagementId);
  p.mate = await hire('Mani Mate', U.mate, p.mgr.engagementId);
  // Only today's weekday is a working day.
  const working = isoWeekday(today);
  const shift = await agents
    .admin!.post('/api/shifts', {
      code: 'ONEDAY',
      name: 'One day a week',
      startTime: '09:00',
      endTime: '18:00',
      graceMinutes: 0,
      weeklyOffs: [1, 2, 3, 4, 5, 6, 7].filter((w) => w !== working),
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
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('asking for comp-off (decision #73: for a weekly off or holiday worked)', () => {
  it('is only for a weekly off or holiday, in the past few weeks, once a day', async () => {
    const working = await ask('emp', { workedOn: d(-7), days: 1 }).expect(400);
    expect(working.body.message).toBe('Comp-off is for a weekly off or holiday you worked');
    const ahead = await ask('emp', { workedOn: d(1), days: 1 }).expect(400);
    expect(ahead.body.message).toBe('Ask for comp-off after the day you worked');
    const old = await ask('emp', { workedOn: d(-31), days: 1 }).expect(400);
    expect(old.body.message).toBe(
      'Comp-off can be asked for up to 30 days after the day worked; ask HR for older days',
    );
    const half = await ask('emp', { workedOn: d(-1), days: 1.5 }).expect(400);
    expect(half.body.fields).toEqual(['days']);

    const asked = await ask('emp', {
      workedOn: d(-1),
      days: 1,
      reason: 'Release support',
    }).expect(201);
    expect(asked.body).toMatchObject({
      workedOn: d(-1),
      days: 1,
      status: 'applied',
      dayKind: 'Weekly off',
      validUntil: null,
    });
    const again = await ask('emp', { workedOn: d(-1), days: 0.5 }).expect(409);
    expect(again.body.message).toBe('There is already a comp-off request for this day');
  });

  it('gives the manager what they need on the card, and credits it on approval', async () => {
    const card = (await cardOf('mgr', p.emp.personId))!;
    expect(card.title).toBe(`Comp-off: Ezhil Employee, worked ${shortDate(d(-1))}`);
    const lines = Object.fromEntries(card.changes.map((c) => [c.label, c.to]));
    expect(lines).toMatchObject({
      'Worked on': `${shortDate(d(-1))} (weekly off)`,
      Attendance: 'No check-in recorded',
      'Comp-off': '1 day, usable for 60 days after approval',
      Reason: 'Release support',
    });
    expect(card.changes.find((c) => c.label === 'Comp-off balance')).toMatchObject({
      from: '0',
      to: '1',
    });
    // Someone else's manager can't see it, and the employee can't approve their own.
    expect(await cardOf('mate', p.emp.personId)).toBeUndefined();

    await approve('mgr', p.emp.personId);
    const [granted] = await mine('emp');
    expect(granted).toMatchObject({ status: 'approved', grantedOn: today, validUntil: d(60) });
    const balance = await coBalance(p.emp);
    expect(balance).toMatchObject({ granted: 1, balance: 1 });
    expect(balance.entries.at(-1)).toMatchObject({
      kind: 'grant',
      days: 1,
      note: `Worked ${shortDate(d(-1))} (weekly off); usable until ${shortDate(d(60))}`,
    });
    expect(balance.expiring).toEqual([{ days: 1, on: d(60) }]);
    // The journey shows the grant.
    const journey = await agents.hr!.get(`/api/people/${p.emp.personId}/journey`).expect(200);
    expect(JSON.stringify(journey.body)).toContain('Comp-off granted');
  });

  it('can be returned, asked again, and withdrawn before it is decided', async () => {
    await ask('emp', { workedOn: d(-2), days: 0.5 }).expect(201);
    const card = (await cardOf('mgr', p.emp.personId))!;
    await agents
      .mgr!.post(`/api/approvals/${card.approvalId}/reject`, { comment: 'Only two hours' })
      .expect(201);
    expect((await mine('emp')).find((r) => r.workedOn === d(-2))?.status).toBe('returned');
    const open = (await mine('emp')).find((r) => r.workedOn === d(-2))!;
    await agents.emp!.post(`/api/leave/comp-off/${open.id}/cancel`).expect(200);
    expect((await mine('emp')).find((r) => r.workedOn === d(-2))?.status).toBe('withdrawn');
    // Withdrawn, the day can be asked for again.
    await ask('emp', { workedOn: d(-2), days: 0.5 }).expect(201);
    await approve('mgr', p.emp.personId);
    expect((await coBalance(p.emp)).balance).toBe(1.5);
  });

  it('only for the employee themselves: a manager or HR grants through the request, not directly', async () => {
    await ask('admin', { workedOn: d(-1), days: 1 }).expect(403);
  });
});

describe('using and expiring comp-off (decision #71: expires 60 days after it is granted)', () => {
  it('can be taken as leave only while it is valid', async () => {
    // Make the first grant run out in two days; the half day is valid for 60.
    await pool.query(
      `update comp_off_request set valid_until = $2 where person_id = $1 and worked_on = $3`,
      [p.emp.personId, d(2), d(-1)],
    );
    const inTime = (
      await agents
        .emp!.post('/api/leave/requests/preview', {
          leaveTypeId: typeId('CO'),
          from: today,
          to: today,
        })
        .expect(200)
    ).body as LeavePreview;
    expect(inTime).toMatchObject({ days: 1, fromType: 1, lop: 0, balanceBefore: 1.5 });
    // A week on, only the half day is still valid: the rest would be loss of pay.
    const late = (
      await agents
        .emp!.post('/api/leave/requests/preview', {
          leaveTypeId: typeId('CO'),
          from: d(7),
          to: d(7),
        })
        .expect(200)
    ).body as LeavePreview;
    expect(late).toMatchObject({ days: 1, fromType: 0.5, lop: 0.5, balanceBefore: 0.5 });
  });

  it('takes leave from the grant that expires first, and expires only what is left', async () => {
    await agents
      .emp!.post('/api/leave/requests', {
        leaveTypeId: typeId('CO'),
        from: today,
        to: today,
        startHalf: 'second',
      })
      .expect(201);
    // Asked, not yet approved: the half day is held against the first grant already.
    await approve('mgr', p.emp.personId);
    expect((await coBalance(p.emp)).balance).toBe(1);

    const first = await expire(d(3));
    expect(first).toEqual({ expired: 1, days: 0.5 });
    // Running again changes nothing.
    expect(await expire(d(3))).toEqual({ expired: 0, days: 0 });
    const balance = await coBalance(p.emp);
    expect(balance.balance).toBe(0.5);
    expect(balance.entries.at(-1)).toMatchObject({
      kind: 'expiry',
      days: -0.5,
      note: `Comp-off for ${shortDate(d(-1))} expired after ${shortDate(d(2))}; 0.5 of 1 day had been used`,
    });
    expect(balance.lapsed).toBe(0.5);
    expect((await mine('emp')).find((r) => r.workedOn === d(-1))).toMatchObject({
      expiredDays: 0.5,
    });
  });

  it('expires a grant in full when none of it was used', async () => {
    const on = d(61);
    const year = Number(on.slice(0, 4));
    if (year !== Number(today.slice(0, 4))) {
      // The daily job closes the year first in January: comp-off carries forward, then expires.
      await runWithContext({ tenantId: tenant }, () =>
        app.get(LeaveService).closeYear(Number(today.slice(0, 4))),
      );
      expect((await coBalance(p.emp, year)).opening).toBe(0.5);
    }
    expect(await expire(on)).toEqual({ expired: 1, days: 0.5 });
    const after = await coBalance(p.emp, year);
    expect(after.balance).toBe(0);
    expect(after.expiring).toEqual([]);
  });
});

function shortDate(iso: string) {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}
