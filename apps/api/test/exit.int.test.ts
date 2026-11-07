import type { INestApplication } from '@nestjs/common';
import type { ApprovalCard, ChecklistRunView, ExitCaseView, MyExitView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only. Notice (decision #80): 30 days on probation, 60 confirmed.
const U = {
  admin: '00000000-0000-4000-8000-000000610001',
  hr: '00000000-0000-4000-8000-000000610002',
  hrHead: '00000000-0000-4000-8000-000000610003',
  mgr: '00000000-0000-4000-8000-000000610004',
  other: '00000000-0000-4000-8000-000000610005',
  emp: '00000000-0000-4000-8000-000000610006',
  mate: '00000000-0000-4000-8000-000000610007',
  quick: '00000000-0000-4000-8000-000000610008',
  gone: '00000000-0000-4000-8000-000000610009',
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
const p = {} as Record<'mgr' | 'emp' | 'mate' | 'quick' | 'gone', Hire>;

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
  return res.body as Hire;
}

const mine = async (who: string) =>
  (await agents[who]!.get('/api/exits/mine').expect(200)).body as MyExitView;
const caseOf = async (who: string, id: string) =>
  (await agents[who]!.get(`/api/exits/${id}`).expect(200)).body as ExitCaseView;
const cardFor = async (who: string, personId: string) =>
  ((await agents[who]!.get('/api/approvals').expect(200)).body as ApprovalCard[]).find(
    (c) => c.subject.personId === personId,
  );
const engagement = async (h: Hire) =>
  (
    await pool.query(
      `select status, last_working_date::text as lwd, resignation_date::text as rd, exit_reason
         from engagement where id = $1`,
      [h.engagementId],
    )
  ).rows[0] as {
    status: string;
    lwd: string | null;
    rd: string | null;
    exit_reason: string | null;
  };
const checklists = async (h: Hire) =>
  (await agents.hr!.get(`/api/people/${h.personId}/checklists`).expect(200))
    .body as ChecklistRunView[];

beforeAll(async () => {
  tenant = await newTenant(pool, 'Exit tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Ex Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Ex HR', ['employee', 'hr']);
  await addUser(db, tenant, U.hrHead, 'Ex HR Head', ['employee', 'hr_head']);
  await addUser(db, tenant, U.mgr, 'Ex Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.other, 'Ex Other Manager', ['employee', 'manager']);
  for (const key of ['emp', 'mate', 'quick', 'gone'] as const) {
    await addUser(db, tenant, U[key], `Ex ${key}`, ['employee']);
  }
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  p.mgr = await hire('Mohana Manager', U.mgr);
  p.emp = await hire('Eshwar Employee', U.emp, p.mgr.engagementId);
  p.mate = await hire('Meghna Mate', U.mate, p.mgr.engagementId);
  p.quick = await hire('Kavin Quick', U.quick, p.mgr.engagementId);
  p.gone = await hire('Gita Gone', U.gone, p.mgr.engagementId);
  // Eshwar and Meghna are confirmed (60 days' notice); Kavin and Gita are still on probation.
  await pool.query(
    `update engagement set confirmation_date = '2024-07-08' where id = any($1::uuid[])`,
    [[p.emp.engagementId, p.mate.engagementId]],
  );
  await agents
    .admin!.put('/api/letter-templates/termination', {
      name: 'Termination letter',
      type: 'termination',
      body: 'Dear {{person.legalName}},\n\nYour employment ends on {{extra.lastWorkingDate}}.',
      approverRole: null,
      signature: 'none',
    })
    .expect(200);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('resigning (E10; spec workflow 7)', () => {
  let id: string;

  it('shows the notice before resigning, and takes a reason and a proposed last day', async () => {
    expect(await mine('emp')).toMatchObject({
      current: null,
      noticeDays: 60,
      noticeLastDay: d(60),
      onProbation: false,
    });
    expect(await mine('quick')).toMatchObject({ noticeDays: 30, onProbation: true });
    const late = await agents
      .emp!.post('/api/exits/resign', { reason: 'better_opportunity', proposedLastDay: d(61) })
      .expect(400);
    expect(late.body.message).toMatch(/can be up to .*, the end of the notice period$/);
    const res = await agents
      .emp!.post('/api/exits/resign', {
        reason: 'better_opportunity',
        note: 'Moving to a product company',
        proposedLastDay: d(30),
      })
      .expect(201);
    const view = res.body as ExitCaseView;
    id = view.id;
    expect(view).toMatchObject({
      kind: 'resignation',
      status: 'submitted',
      resignationDate: today,
      noticeDays: 60,
      noticeLastDay: d(60),
      proposedLastDay: d(30),
      waitingFor: 'manager',
      can: { withdraw: true, managerAccept: false, hrAccept: false },
    });
    await agents
      .emp!.post('/api/exits/resign', { reason: 'personal', proposedLastDay: d(30) })
      .expect(409);
    // HR is told at once, as well as the manager.
    const notes = (await agents.hr!.get('/api/notifications').expect(200)).body as {
      title: string;
    }[];
    expect(notes.some((n) => n.title.startsWith('Resignation: Eshwar Employee'))).toBe(true);
  });

  it('the manager accepts only after recording the retention conversation', async () => {
    const card = (await cardFor('mgr', p.emp.personId))!;
    expect(card.link).toBe(`/exits/${id}`);
    expect(card.waitingFor).toBe('Record the retention conversation on the exit page first');
    await agents.mgr!.post(`/api/approvals/${card.approvalId}/approve`, {}).expect(409);
    await agents
      .other!.post(`/api/exits/${id}/manager-accept`, { retentionNote: 'Not my team' })
      .expect(403);
    const accepted = (
      await agents
        .mgr!.post(`/api/exits/${id}/manager-accept`, {
          retentionNote: 'Offered a move to the platform team; declined',
        })
        .expect(200)
    ).body as ExitCaseView;
    expect(accepted).toMatchObject({
      waitingFor: 'hr',
      retentionNote: 'Offered a move to the platform team; declined',
    });
    // The employee never sees the retention note.
    expect((await caseOf('emp', id)).retentionNote).toBeNull();
  });

  it('HR fixes the last day; earlier than the notice needs a buyout or waiver and HR head', async () => {
    const early = await agents
      .hr!.post(`/api/exits/${id}/hr-accept`, { lastWorkingDate: d(30) })
      .expect(400);
    expect(early.body.message).toBe(
      'A last day 30 days before the end of the notice needs a buyout or a waiver',
    );
    const withHead = (
      await agents
        .hr!.post(`/api/exits/${id}/hr-accept`, { lastWorkingDate: d(30), earlyRelease: 'buyout' })
        .expect(200)
    ).body as ExitCaseView;
    expect(withHead).toMatchObject({
      status: 'submitted',
      waitingFor: 'hr_head',
      earlyRelease: 'buyout',
      buyoutDays: 30,
      lastWorkingDate: d(30),
    });
    const card = (await cardFor('hrHead', p.emp.personId))!;
    expect(card.changes.find((c) => c.label === 'Early release')?.to).toBe(
      'Buyout of 30 notice days',
    );
    await agents.hrHead!.post(`/api/approvals/${card.approvalId}/approve`, {}).expect(201);
  });

  it('on acceptance: serving notice to the last day, and the exit checklist is created', async () => {
    const view = await caseOf('hr', id);
    expect(view).toMatchObject({ status: 'serving_notice', waitingFor: null });
    expect(await engagement(p.emp)).toEqual({
      status: 'on_notice',
      lwd: d(30),
      rd: today,
      exit_reason: 'better_opportunity',
    });
    const runs = (await checklists(p.emp)).filter((r) => r.stage === 'exit');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      templateName: 'Exit clearance',
      anchorDate: d(30),
      status: 'open',
    });
    expect(runs[0]!.tasks.length).toBeGreaterThan(3);
    expect(view.checklist).toEqual({ done: 0, total: runs[0]!.tasks.length });
    const journey = JSON.stringify(
      (await agents.hr!.get(`/api/people/${p.emp.personId}/journey`).expect(200)).body,
    );
    expect(journey).toContain('Resignation submitted');
    expect(journey).toContain('Resignation accepted');
  });

  it('a last day at the end of the notice needs no HR head', async () => {
    const res = await agents
      .mate!.post('/api/exits/resign', { reason: 'relocation', proposedLastDay: d(60) })
      .expect(201);
    const mateId = (res.body as ExitCaseView).id;
    await agents
      .mgr!.post(`/api/exits/${mateId}/manager-accept`, { retentionNote: 'Moving cities' })
      .expect(200);
    const done = (
      await agents
        .hr!.post(`/api/exits/${mateId}/hr-accept`, { lastWorkingDate: d(60) })
        .expect(200)
    ).body as ExitCaseView;
    expect(done).toMatchObject({ status: 'serving_notice', earlyRelease: null, buyoutDays: null });
  });
});

describe('withdrawing (spec: before acceptance at once; after, the manager and HR approve)', () => {
  it('withdraws a resignation not yet accepted at once', async () => {
    const res = await agents
      .quick!.post('/api/exits/resign', { reason: 'personal', proposedLastDay: d(30) })
      .expect(201);
    const view = (
      await agents
        .quick!.post(`/api/exits/${(res.body as ExitCaseView).id}/withdraw`, {
          reason: 'Sorted things out at home',
        })
        .expect(200)
    ).body as ExitCaseView;
    expect(view.status).toBe('withdrawn');
    expect((await mine('quick')).current).toBeNull();
    expect(await cardFor('mgr', p.quick.personId)).toBeUndefined();
  });

  it('after acceptance, the manager and HR approve; the person is active again', async () => {
    const current = (await mine('mate')).current!;
    expect(current.status).toBe('serving_notice');
    const asked = (
      await agents
        .mate!.post(`/api/exits/${current.id}/withdraw`, { reason: 'The move fell through' })
        .expect(200)
    ).body as ExitCaseView;
    expect(asked).toMatchObject({ status: 'serving_notice', withdrawal: { status: 'pending' } });
    for (const who of ['mgr', 'hr']) {
      const card = (await cardFor(who, p.mate.personId))!;
      expect(card.title).toMatch(/^Withdraw resignation: Meghna Mate/);
      await agents[who]!.post(`/api/approvals/${card.approvalId}/approve`, {}).expect(201);
    }
    expect((await caseOf('hr', current.id)).status).toBe('withdrawn');
    expect(await engagement(p.mate)).toEqual({
      status: 'active',
      lwd: null,
      rd: null,
      exit_reason: null,
    });
    expect((await checklists(p.mate)).find((r) => r.stage === 'exit')?.status).toBe('cancelled');
  });
});

describe('termination (spec: HR head; termination letter; the same checklist)', () => {
  it('is for HR head only, and starts the exit with a letter and the checklist', async () => {
    await agents
      .hr!.post(`/api/people/${p.gone.personId}/terminate`, {
        lastWorkingDate: d(30),
        reason: 'Performance',
      })
      .expect(403);
    const view = (
      await agents
        .hrHead!.post(`/api/people/${p.gone.personId}/terminate`, {
          lastWorkingDate: d(30),
          reason: 'Did not meet the performance plan',
        })
        .expect(201)
    ).body as ExitCaseView;
    expect(view).toMatchObject({
      kind: 'termination',
      status: 'serving_notice',
      lastWorkingDate: d(30),
    });
    expect((await engagement(p.gone)).status).toBe('on_notice');
    const letters = (await agents.hr!.get(`/api/people/${p.gone.personId}/letters`).expect(200))
      .body as { type: string }[];
    expect(letters.map((l) => l.type)).toContain('termination');
    expect((await checklists(p.gone)).filter((r) => r.stage === 'exit')).toHaveLength(1);
  });
});

describe('the exit tracker (H8)', () => {
  it('lists exits for HR, the team for a manager, and refuses employees', async () => {
    const all = (await agents.hr!.get('/api/exits').expect(200)).body as ExitCaseView[];
    expect(all.map((x) => x.name).sort()).toEqual(['Eshwar Employee', 'Gita Gone']);
    const withClosed = (await agents.hr!.get('/api/exits?closed=true').expect(200))
      .body as ExitCaseView[];
    expect(withClosed).toHaveLength(4);
    expect((await agents.other!.get('/api/exits').expect(200)).body).toEqual([]);
    expect(((await agents.mgr!.get('/api/exits').expect(200)).body as ExitCaseView[]).length).toBe(
      2,
    );
    await agents.emp!.get('/api/exits').expect(403);
    // A manager sees the reason on the case but never the retention note of another manager.
    const forOther = await agents.other!.get(`/api/exits/${all[0]!.id}`);
    expect(forOther.status).toBe(403);
  });
});
