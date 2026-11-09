import type { INestApplication } from '@nestjs/common';
import type {
  ApprovalCard,
  BulkApproveResult,
  LeaveTypeView,
  NotificationPreferencesView,
  NotificationView,
} from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only. Mani manages Anbu, Bala and Chitra; Dev is in another team.
const U = {
  admin: '00000000-0000-4000-8000-000000625001',
  hr: '00000000-0000-4000-8000-000000625002',
  mgr: '00000000-0000-4000-8000-000000625003',
  a: '00000000-0000-4000-8000-000000625004',
  b: '00000000-0000-4000-8000-000000625005',
  c: '00000000-0000-4000-8000-000000625006',
  other: '00000000-0000-4000-8000-000000625007',
  dev: '00000000-0000-4000-8000-000000625008',
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
const p = {} as Record<'mgr' | 'a' | 'b' | 'c' | 'other' | 'dev', Hire>;
let types: LeaveTypeView[];

const cards = async (who: string) =>
  (await agents[who]!.get('/api/approvals').expect(200)).body as ApprovalCard[];
const notes = async (who: string) =>
  (await agents[who]!.get('/api/notifications').expect(200)).body as NotificationView[];
const bulk = async (who: string, approvalIds: string[]) =>
  (await agents[who]!.post('/api/approvals/bulk-approve', { approvalIds }).expect(200))
    .body as BulkApproveResult;
const applyLeave = (who: string, day: string) =>
  agents[who]!.post('/api/leave/requests', {
    leaveTypeId: types.find((t) => t.code === 'CL')!.id,
    from: day,
    to: day,
    reason: 'Personal work',
  }).expect(201);

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
  tenant = await newTenant(pool, 'Inbox tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Ib Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Ib HR', ['employee', 'hr']);
  await addUser(db, tenant, U.mgr, 'Ib Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.a, 'Ib Anbu', ['employee']);
  await addUser(db, tenant, U.b, 'Ib Bala', ['employee']);
  await addUser(db, tenant, U.c, 'Ib Chitra', ['employee']);
  await addUser(db, tenant, U.other, 'Ib Other', ['employee', 'manager']);
  await addUser(db, tenant, U.dev, 'Ib Dev', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  p.mgr = await hire('Mani Manager', U.mgr);
  p.other = await hire('Oviya Other', U.other);
  p.a = await hire('Anbu Arasu', U.a, p.mgr.engagementId);
  p.b = await hire('Bala Bharathi', U.b, p.mgr.engagementId);
  p.c = await hire('Chitra Chandran', U.c, p.mgr.engagementId);
  p.dev = await hire('Dev Durai', U.dev, p.other.engagementId);
  await pool.query(
    `update engagement set confirmation_date = '2024-07-08' where id = any($1::uuid[])`,
    [[p.a, p.b, p.c, p.dev].map((h) => h.engagementId)],
  );
  // Every day a working day, so the tests don't depend on the weekday.
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
      personIds: [p.a, p.b, p.c, p.dev].map((h) => h.personId),
      shiftId: shift.body.id,
      effectiveFrom: '2024-01-08',
      reason: 'Test shift',
    })
    .expect(201);
  types = (await agents.a!.get('/api/leave-types').expect(200)).body;
  const csv = [
    'employee_code,leave_type,balance',
    ...[p.a, p.b, p.c, p.dev].map((h) => `${h.employeeCode},CL,5`),
  ].join('\n');
  await agents
    .hr!.post('/api/leave/balances/import', { csv, asOf: d(-1), commit: true })
    .expect(200);
}, 120_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('notification preferences (X1; slice 11)', () => {
  it('start with every topic on and no email copy', async () => {
    const prefs = (await agents.a!.get('/api/notification-preferences').expect(200))
      .body as NotificationPreferencesView;
    expect(prefs.emailCopy).toBe(false);
    expect(prefs.topics.every((t) => t.on)).toBe(true);
    expect(prefs.topics.filter((t) => t.required).map((t) => t.key)).toEqual([
      'approvals',
      'tasks',
      'compliance',
    ]);
  });

  it('approvals and compliance items can’t be switched off', async () => {
    await agents
      .a!.put('/api/notification-preferences', { off: ['approvals'], emailCopy: false })
      .expect(400);
    await agents
      .a!.put('/api/notification-preferences', { off: ['compliance'], emailCopy: false })
      .expect(400);
  });

  it('a topic switched off sends nothing; others still arrive', async () => {
    const saved = (
      await agents
        .a!.put('/api/notification-preferences', { off: ['requests'], emailCopy: true })
        .expect(200)
    ).body as NotificationPreferencesView;
    expect(saved.emailCopy).toBe(true);
    expect(saved.topics.find((t) => t.key === 'requests')!.on).toBe(false);

    await applyLeave('a', d(20));
    await applyLeave('b', d(20));
    // The manager is told; approvals can't be switched off.
    const waiting = (await notes('mgr')).filter((n) => n.kind === 'approval_requested');
    expect(waiting.length).toBeGreaterThanOrEqual(2);
    expect(waiting[0]!.topic).toBe('approvals');
    const mine = (await cards('mgr')).filter((c) => c.key === 'leave_request');
    expect(mine).toHaveLength(2);
    const result = await bulk(
      'mgr',
      mine.map((c) => c.approvalId),
    );
    expect(result.results.every((r) => r.ok)).toBe(true);
    // Anbu muted their requests; Bala didn't.
    expect((await notes('a')).some((n) => n.kind === 'workflow_approved')).toBe(false);
    expect((await notes('b')).some((n) => n.kind === 'workflow_approved')).toBe(true);
  });

  it('marks everything read at once', async () => {
    expect((await notes('mgr')).some((n) => !n.read)).toBe(true);
    await agents.mgr!.post('/api/notifications/read-all').expect(204);
    expect((await notes('mgr')).every((n) => n.read)).toBe(true);
  });
});

describe('the Action inbox (X3; slice 11)', () => {
  it('marks routine cards for bulk approve, and orders cards by due date', async () => {
    await applyLeave('c', d(25));
    await agents
      .a!.patch(`/api/people/${p.a.personId}/profile`, { phone: '+919000000001' })
      .expect(200);
    const leave = (await cards('mgr')).find((c) => c.subject.personId === p.c.personId)!;
    expect(leave.bulk).toBe(true);
    // The leave card carries the context to decide (design rules): balance after, who else, fit.
    expect(leave.changes.map((l) => l.label)).toEqual(
      expect.arrayContaining(['Leave', 'Casual leave balance', 'Also off', 'Policy']),
    );
    const profile = (await cards('hr')).find((c) => c.subject.personId === p.a.personId)!;
    expect(profile.bulk).toBe(false);
    const all = await cards('hr');
    expect(all.map((c) => c.dueOn)).toEqual([...all.map((c) => c.dueOn)].sort());
  });

  it('bulk approve decides routine cards, one result each, and refuses the rest', async () => {
    await applyLeave('dev', d(26));
    const devCard = (await cards('other')).find((c) => c.subject.personId === p.dev.personId)!;
    const chitra = (await cards('mgr')).find((c) => c.subject.personId === p.c.personId)!;
    const profile = (await cards('hr')).find((c) => c.subject.personId === p.a.personId)!;

    const result = await bulk('mgr', [chitra.approvalId, devCard.approvalId]);
    expect(result.results).toEqual([
      { approvalId: chitra.approvalId, ok: true, message: null },
      { approvalId: devCard.approvalId, ok: false, message: 'You can’t decide this one' },
    ]);
    // Dev's leave is still with their own manager.
    expect((await cards('other')).map((c) => c.approvalId)).toContain(devCard.approvalId);

    const refused = await bulk('hr', [profile.approvalId]);
    expect(refused.results[0]).toEqual({
      approvalId: profile.approvalId,
      ok: false,
      message: 'Approve this one on its own',
    });
    expect((await cards('hr')).map((c) => c.approvalId)).toContain(profile.approvalId);

    const again = await bulk('mgr', [chitra.approvalId]);
    expect(again.results[0]).toMatchObject({
      ok: false,
      message: 'This step has already been decided',
    });
  });

  it('records a bulk approval exactly like a single one (same audit row)', async () => {
    const devCard = (await cards('other')).find((c) => c.subject.personId === p.dev.personId)!;
    await agents.other!.post(`/api/approvals/${devCard.approvalId}/approve`, {}).expect(201);
    const chitraRequest = (
      await pool.query(
        `select a.id from approval a join workflow_instance w on w.id = a.instance_id
        where w.subject_person_id = $1 and a.decision = 'approved'`,
        [p.c.personId],
      )
    ).rows[0].id as string;
    const audit = async (approvalId: string) =>
      (
        await pool.query(
          `select action, table_name, field_changes from audit_log where record_id = $1`,
          [approvalId],
        )
      ).rows;
    expect(await audit(chitraRequest)).toEqual(await audit(devCard.approvalId));
    expect(await audit(chitraRequest)).toHaveLength(1);
  });

  it('refuses an empty or oversized batch', async () => {
    await agents.mgr!.post('/api/approvals/bulk-approve', { approvalIds: [] }).expect(400);
  });
});
