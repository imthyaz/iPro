import type { INestApplication } from '@nestjs/common';
import type {
  AskResponse,
  AssistantArchiveView,
  LeaveTypeView,
  NotificationView,
} from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BriefService } from '../src/assistant/brief.service.js';
import { LLM, type ScriptedLlm } from '../src/assistant/llm.js';
import { AssistantRetentionService } from '../src/assistant/retention.service.js';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only. Maran manages Ezhil.
const U = {
  admin: '00000000-0000-4000-8000-000000675001',
  hr: '00000000-0000-4000-8000-000000675002',
  mgr: '00000000-0000-4000-8000-000000675003',
  ezhil: '00000000-0000-4000-8000-000000675004',
};
type Who = keyof typeof U;
const email = (id: string) => `${id}@test.ipro.test`;
const today = businessDate(new Date());
const d = (n: number) => addDays(today, n);

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
let llm: ScriptedLlm;
const agents: Record<string, ReturnType<typeof as>> = {};
type Hire = { personId: string; engagementId: string; employeeCode: string };
const p = {} as Record<'mgr' | 'ezhil', Hire>;
let types: LeaveTypeView[];

const ask = async (who: Who, text: string, conversationId?: string) =>
  (
    await agents[who]!.post('/api/assistant/ask', {
      text,
      ...(conversationId ? { conversationId } : {}),
    }).expect(200)
  ).body as AskResponse;
const asSystem = <T>(fn: () => Promise<T>) => runWithContext({ tenantId: tenant }, fn);
const briefs = async (who: Who) =>
  ((await agents[who]!.get('/api/notifications').expect(200)).body as NotificationView[]).filter(
    (n) => n.kind === 'daily_brief',
  );

async function hire(name: string, userId: string, manager?: string): Promise<Hire> {
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
        ...(manager ? { managerEngagementId: manager } : {}),
      },
    })
    .expect(201);
  return res.body as Hire;
}

beforeAll(async () => {
  tenant = await newTenant(pool, 'Ask iPro retention tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Rt Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Rt HR', ['employee', 'hr']);
  await addUser(db, tenant, U.mgr, 'Rt Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.ezhil, 'Rt Ezhil', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  llm = app.get<ScriptedLlm>(LLM);
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  p.mgr = await hire('Maran Manager', U.mgr);
  p.ezhil = await hire('Ezhil Elango', U.ezhil, p.mgr.engagementId);
  await pool.query(`update engagement set confirmation_date = '2024-07-08' where id = $1`, [
    p.ezhil.engagementId,
  ]);
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
      personIds: [p.ezhil.personId],
      shiftId: shift.body.id,
      effectiveFrom: '2024-01-08',
      reason: 'Test shift',
    })
    .expect(201);
  types = (await agents.ezhil!.get('/api/leave-types').expect(200)).body;
  for (const year of new Set([today.slice(0, 4), d(30).slice(0, 4), d(45).slice(0, 4)])) {
    const asOf = year === today.slice(0, 4) ? d(-1) : `${year}-01-01`;
    await agents
      .hr!.post('/api/leave/balances/import', {
        csv: `employee_code,leave_type,balance\n${p.ezhil.employeeCode},CL,6`,
        asOf,
        commit: true,
      })
      .expect(200);
  }
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('the 09:00 daily brief (decision #92)', () => {
  it('tells a manager what is waiting, once a day; nothing for those with nothing waiting', async () => {
    const cl = types.find((t) => t.code === 'CL')!.id;
    await agents
      .ezhil!.post('/api/leave/requests', { leaveTypeId: cl, from: d(25), to: d(25) })
      .expect(201);
    await asSystem(() => app.get(BriefService).run(today));
    await asSystem(() => app.get(BriefService).run(today));
    expect((await briefs('mgr')).map((n) => n.title)).toEqual(['Today: 1 approval waiting']);
    expect((await briefs('mgr'))[0]!.topic).toBe('brief');
    // Employees get no brief; HR has nothing waiting today.
    expect(await briefs('ezhil')).toEqual([]);
    expect(await briefs('hr')).toEqual([]);
  });

  it('can be switched off', async () => {
    await agents
      .mgr!.put('/api/notification-preferences', { off: ['brief'], emailCopy: false })
      .expect(200);
    await asSystem(() => app.get(BriefService).run(d(1)));
    expect(await briefs('mgr')).toHaveLength(1);
    await agents
      .mgr!.put('/api/notification-preferences', { off: [], emailCopy: false })
      .expect(200);
  });
});

describe('180-day retention (slice 12 done-when #6)', () => {
  let oldId: string;
  let recentId: string;

  beforeAll(async () => {
    llm.script(/^My leave balance$/, [
      { tool: 'my_leave_balances', input: {} },
      { text: 'Casual leave: 6' },
    ]);
    llm.script(/^Show my journey$/, [
      { tool: 'person_journey', input: { personId: p.ezhil.personId } },
      { text: 'Here is your journey.' },
    ]);
    llm.script(/^Apply casual leave on day 40$/, [
      { tool: 'propose_leave', input: { leaveType: 'CL', from: d(40), to: d(40) } },
      { text: 'Tap Apply to send it.' },
    ]);
    const first = await ask('ezhil', 'My leave balance');
    oldId = first.conversationId;
    await ask('ezhil', 'Show my journey', oldId);
    const card = (await ask('ezhil', 'Apply casual leave on day 40', oldId)).answer.action!;
    await agents.ezhil!.post(`/api/assistant/actions/${card.id}/confirm`).expect(200);
    recentId = (await ask('ezhil', 'My leave balance')).conversationId;
    // The first conversation's last message was 181 days ago.
    await pool.query(
      `update assistant_conversation set last_at = now() - interval '181 days' where id = $1`,
      [oldId],
    );
  });

  it('replaces a conversation idle for 180 days by its summary and deletes the text', async () => {
    expect(await asSystem(() => app.get(AssistantRetentionService).run())).toBe(1);
    const { rows: messages } = await pool.query(
      `select count(*)::int as n from assistant_message where conversation_id = $1`,
      [oldId],
    );
    expect(messages[0].n).toBe(0);
    const { rows: actions } = await pool.query(
      `select count(*)::int as n from assistant_action where conversation_id = $1`,
      [oldId],
    );
    expect(actions[0].n).toBe(0);
    const { rows: conversation } = await pool.query(
      `select title, archived_at is not null as archived from assistant_conversation where id = $1`,
      [oldId],
    );
    expect(conversation[0]).toEqual({ title: 'Leave, People', archived: true });
    await agents.ezhil!.get(`/api/assistant/conversations/${oldId}`).expect(404);
    // The recent one is untouched.
    await agents.ezhil!.get(`/api/assistant/conversations/${recentId}`).expect(200);
  });

  it('keeps the summary searchable by its owner only', async () => {
    const archive = (await agents.ezhil!.get('/api/assistant/archive').expect(200))
      .body as AssistantArchiveView[];
    expect(archive).toHaveLength(1);
    expect(archive[0]).toMatchObject({
      summary: 'Asked about leave and people; applied for leave.',
      topics: ['Leave', 'People'],
      people: [{ personId: p.ezhil.personId, name: 'Ezhil Elango' }],
      actions: [{ kind: 'apply_leave', status: 'confirmed' }],
    });
    expect(
      (await agents.ezhil!.get('/api/assistant/archive?q=ezhil').expect(200)).body,
    ).toHaveLength(1);
    expect(
      (await agents.ezhil!.get('/api/assistant/archive?q=payroll').expect(200)).body,
    ).toHaveLength(0);
    expect((await agents.mgr!.get('/api/assistant/archive').expect(200)).body).toEqual([]);
  });

  it('keeps confirmed actions in the audit log, and records the deletion', async () => {
    // The leave applied from the card is still there, and so is its confirmation's audit row.
    const leave = (
      await agents.ezhil!.get(`/api/leave/requests/mine?year=${d(40).slice(0, 4)}`).expect(200)
    ).body as { from: string }[];
    expect(leave.some((r) => r.from === d(40))).toBe(true);
    const { rows: confirmed } = await pool.query(
      `select count(*)::int as n from audit_log where table_name = 'assistant_action' and created_by = $1`,
      [U.ezhil],
    );
    expect(confirmed[0].n).toBe(1);
    const { rows: deleted } = await pool.query(
      `select action, field_changes from audit_log where table_name = 'assistant_conversation' and record_id = $1`,
      [oldId],
    );
    expect(deleted).toEqual([
      {
        action: 'delete',
        field_changes: [
          { field: 'messages', from: 6, to: 0 },
          { field: 'actions', from: 1, to: 0 },
        ],
      },
    ]);
  });

  it('runs again without archiving anything twice', async () => {
    expect(await asSystem(() => app.get(AssistantRetentionService).run())).toBe(0);
  });
});
