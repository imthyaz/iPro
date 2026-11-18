import type { INestApplication } from '@nestjs/common';
import type {
  ApprovalCard,
  AskResponse,
  AssistantActionView,
  AssistantConversationView,
  LeaveRequestView,
  LeaveTypeView,
} from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LLM, type ScriptedLlm } from '../src/assistant/llm.js';
import { AssistantTools } from '../src/assistant/tools.js';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only. Maran manages Ezhil and Ilango.
const U = {
  admin: '00000000-0000-4000-8000-000000665001',
  hr: '00000000-0000-4000-8000-000000665002',
  mgr: '00000000-0000-4000-8000-000000665003',
  ezhil: '00000000-0000-4000-8000-000000665004',
  ilango: '00000000-0000-4000-8000-000000665005',
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
const p = {} as Record<'mgr' | 'ezhil' | 'ilango', Hire>;
let types: LeaveTypeView[];

const ask = async (who: Who, text: string) =>
  (await agents[who]!.post('/api/assistant/ask', { text }).expect(200)).body as AskResponse;
const confirm = (who: Who, id: string) => agents[who]!.post(`/api/assistant/actions/${id}/confirm`);
const mine = async (who: Who, on = today) =>
  (await agents[who]!.get(`/api/leave/requests/mine?year=${on.slice(0, 4)}`).expect(200))
    .body as LeaveRequestView[];
const auditOf = async (id: string) =>
  (
    await pool.query(
      `select action, table_name, field_changes, created_by from audit_log where record_id = $1 order by at`,
      [id],
    )
  ).rows;

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
  tenant = await newTenant(pool, 'Ask iPro action tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Ac Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Ac HR', ['employee', 'hr']);
  await addUser(db, tenant, U.mgr, 'Ac Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.ezhil, 'Ac Ezhil', ['employee']);
  await addUser(db, tenant, U.ilango, 'Ac Ilango', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  llm = app.get<ScriptedLlm>(LLM);
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  p.mgr = await hire('Maran Manager', U.mgr);
  p.ezhil = await hire('Ezhil Elango', U.ezhil, p.mgr.engagementId);
  p.ilango = await hire('Ilango Iniyan', U.ilango, p.mgr.engagementId);
  await pool.query(
    `update engagement set confirmation_date = '2024-07-08' where id = any($1::uuid[])`,
    [[p.ezhil, p.ilango].map((h) => h.engagementId)],
  );
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
      personIds: [p.ezhil, p.ilango].map((h) => h.personId),
      shiftId: shift.body.id,
      effectiveFrom: '2024-01-08',
      reason: 'Test shift',
    })
    .expect(201);
  types = (await agents.ezhil!.get('/api/leave-types').expect(200)).body;
  for (const year of new Set([today.slice(0, 4), d(30).slice(0, 4)])) {
    const csv = [
      'employee_code,leave_type,balance',
      ...[p.ezhil, p.ilango].map((h) => `${h.employeeCode},CL,6`),
    ].join('\n');
    const asOf = year === today.slice(0, 4) ? d(-1) : `${year}-01-01`;
    await agents.hr!.post('/api/leave/balances/import', { csv, asOf, commit: true }).expect(200);
  }
  for (const [key, type, name] of [
    ['confirmation', 'confirmation', 'Confirmation letter'],
    ['termination', 'termination', 'Termination letter'],
  ] as const) {
    await agents
      .admin!.put(`/api/letter-templates/${key}`, {
        name,
        type,
        body: 'Dear {{person.legalName}},\n\nThis is a synthetic letter.',
        approverRole: null,
        signature: 'none',
      })
      .expect(200);
  }
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('confirmation cards (slice 12 done-when #3)', () => {
  let card: AssistantActionView;
  let conversationId: string;

  it('preparing leave shows the exact effect and changes nothing', async () => {
    llm.script(/^Apply casual leave on day 10$/, [
      {
        tool: 'propose_leave',
        input: { leaveType: 'casual', from: d(10), to: d(10), reason: 'Errand' },
      },
      { text: 'Here is the leave to apply: tap Apply to send it.' },
    ]);
    const reply = await ask('ezhil', 'Apply casual leave on day 10');
    conversationId = reply.conversationId;
    card = reply.answer.action!;
    expect(card).toMatchObject({ kind: 'apply_leave', status: 'proposed', confirmLabel: 'Apply' });
    expect(card.lines).toEqual([
      { label: 'Leave', value: `Casual leave, ${d(10)}` },
      { label: 'Days', value: '1' },
      { label: 'Casual leave balance', value: '6 → 5' },
      { label: 'Goes to', value: 'Maran Manager for approval' },
    ]);
    expect(await mine('ezhil', d(10))).toHaveLength(0);
  });

  it('only its own user can confirm it', async () => {
    await confirm('ilango', card.id).expect(404);
    await confirm('mgr', card.id).expect(404);
    expect(await mine('ezhil', d(10))).toHaveLength(0);
  });

  it('the tap applies it through the leave service, once, and is audited', async () => {
    const done = (await confirm('ezhil', card.id).expect(200)).body as AssistantActionView;
    expect(done).toMatchObject({ status: 'confirmed', result: { link: '/leave' } });
    const applied = await mine('ezhil', d(10));
    expect(applied.map((r) => [r.leaveType.code, r.from, r.status])).toEqual([
      ['CL', d(10), 'applied'],
    ]);
    // The manager has it to approve, as from the leave screen.
    const cards = (await agents.mgr!.get('/api/approvals').expect(200)).body as ApprovalCard[];
    expect(cards.some((c) => c.subject.personId === p.ezhil.personId)).toBe(true);

    const second = await confirm('ezhil', card.id).expect(409);
    expect(second.body.message).toBe('This card has already been used');
    expect(await mine('ezhil', d(10))).toHaveLength(1);

    expect(await auditOf(card.id)).toEqual([
      {
        action: 'update',
        table_name: 'assistant_action',
        field_changes: [
          { field: 'kind', from: null, to: 'apply_leave' },
          { field: 'status', from: 'proposed', to: 'confirmed' },
        ],
        created_by: U.ezhil,
      },
    ]);
    const view = (
      await agents.ezhil!.get(`/api/assistant/conversations/${conversationId}`).expect(200)
    ).body as AssistantConversationView;
    expect(view.messages.at(-1)!.action).toMatchObject({ id: card.id, status: 'confirmed' });
    const { rows } = await pool.query(
      `select confirmed_action_id from assistant_message where proposed_action_id = $1`,
      [card.id],
    );
    expect(rows).toEqual([{ confirmed_action_id: card.id }]);
  });

  it('a cancelled card can’t be confirmed, and changes nothing', async () => {
    llm.script(/^Apply casual leave on day 11$/, [
      { tool: 'propose_leave', input: { leaveType: 'CL', from: d(11), to: d(11) } },
      { text: 'Tap Apply to send it.' },
    ]);
    const proposed = (await ask('ezhil', 'Apply casual leave on day 11')).answer.action!;
    const cancelled = (
      await agents.ezhil!.post(`/api/assistant/actions/${proposed.id}/cancel`).expect(200)
    ).body as AssistantActionView;
    expect(cancelled.status).toBe('cancelled');
    await confirm('ezhil', proposed.id).expect(409);
    expect((await mine('ezhil', d(11))).filter((r) => r.from === d(11))).toHaveLength(0);
  });

  it('a card expires after 30 minutes', async () => {
    llm.script(/^Apply casual leave on day 12$/, [
      { tool: 'propose_leave', input: { leaveType: 'CL', from: d(12), to: d(12) } },
      { text: 'Tap Apply to send it.' },
    ]);
    const reply = await ask('ezhil', 'Apply casual leave on day 12');
    await pool.query(
      `update assistant_action set expires_at = now() - interval '1 minute' where id = $1`,
      [reply.answer.action!.id],
    );
    const late = await confirm('ezhil', reply.answer.action!.id).expect(409);
    expect(late.body.message).toBe('This card has expired; ask again');
    const view = (
      await agents.ezhil!.get(`/api/assistant/conversations/${reply.conversationId}`).expect(200)
    ).body as AssistantConversationView;
    expect(view.messages.at(-1)!.action!.status).toBe('expired');
  });

  it('leave that can’t be applied gets no card', async () => {
    llm.script(/^Apply casual leave last month$/, [
      { tool: 'propose_leave', input: { leaveType: 'CL', from: d(-40), to: d(-40) } },
      { text: 'That date is too far back.' },
    ]);
    const reply = await ask('ezhil', 'Apply casual leave last month');
    expect(reply.answer.action).toBeNull();
  });
});

describe('approving from a card', () => {
  it('approves the leave waiting for a date, once confirmed', async () => {
    const cl = types.find((t) => t.code === 'CL')!.id;
    await agents
      .ilango!.post('/api/leave/requests', { leaveTypeId: cl, from: d(20), to: d(20) })
      .expect(201);
    await agents
      .ezhil!.post('/api/leave/requests', { leaveTypeId: cl, from: d(20), to: d(21) })
      .expect(201);
    llm.script(/^Approve all pending leave for day 20$/, [
      { tool: 'propose_approvals', input: { date: d(20) } },
      { text: 'Tap Approve to approve them.' },
    ]);
    const card = (await ask('mgr', 'Approve all pending leave for day 20')).answer.action!;
    expect(card.title).toBe(`Approve 2 leave requests for ${d(20)}`);
    expect(card.lines).toEqual(
      expect.arrayContaining([
        { label: 'Ilango Iniyan', value: d(20) },
        { label: 'Ezhil Elango', value: `${d(20)} to ${d(21)}` },
      ]),
    );
    // Not yet approved.
    expect((await mine('ilango', d(20))).find((r) => r.from === d(20))!.status).toBe('applied');
    const done = (await confirm('mgr', card.id).expect(200)).body as AssistantActionView;
    expect(done.result!.text).toBe('Approved 2 of 2.');
    expect((await mine('ilango', d(20))).find((r) => r.from === d(20))!.status).toBe('approved');
    expect((await mine('ezhil', d(20))).find((r) => r.from === d(20))!.status).toBe('approved');
  });
});

describe('drafting letters', () => {
  it('HR drafts a confirmation letter from a card', async () => {
    llm.script(/^Draft a confirmation letter for Ezhil$/, [
      {
        tool: 'propose_letter',
        input: { personId: p.ezhil.personId, templateKey: 'confirmation' },
      },
      { text: 'Tap Draft letter to make it.' },
    ]);
    const card = (await ask('hr', 'Draft a confirmation letter for Ezhil')).answer.action!;
    expect(card.title).toBe('Draft a confirmation letter for Ezhil Elango');
    const before = (await agents.hr!.get(`/api/people/${p.ezhil.personId}/letters`).expect(200))
      .body;
    expect(before).toHaveLength(0);
    await confirm('hr', card.id).expect(200);
    const after = (await agents.hr!.get(`/api/people/${p.ezhil.personId}/letters`).expect(200))
      .body;
    expect(after).toHaveLength(1);
  });

  it('termination letters are made on their own screen, not from chat', async () => {
    llm.script(/^Draft a termination letter for Ilango$/, [
      {
        tool: 'propose_letter',
        input: { personId: p.ilango.personId, templateKey: 'termination' },
      },
      { text: 'Use the exit screen for that.' },
    ]);
    expect((await ask('hr', 'Draft a termination letter for Ilango')).answer.action).toBeNull();
  });

  it('someone who can’t make letters gets no card', async () => {
    llm.script(/^Draft a confirmation letter for Ilango$/, [
      {
        tool: 'propose_letter',
        input: { personId: p.ilango.personId, templateKey: 'confirmation' },
      },
      { text: 'Here you go.' },
    ]);
    const reply = await ask('mgr', 'Draft a confirmation letter for Ilango');
    expect(reply.answer.action).toBeNull();
  });
});

describe('the assistant itself never writes', () => {
  it('every tool either reads or prepares a card', () => {
    const names = app
      .get(AssistantTools)
      .definitions()
      .map((t) => t.name);
    const writers = names.filter(
      (n) =>
        !/^(my_|person_|team_|find_|hybrid_|attendance_|probation_|joiners_|policy_|propose_)/.test(
          n,
        ),
    );
    expect(writers).toEqual([]);
  });
});
