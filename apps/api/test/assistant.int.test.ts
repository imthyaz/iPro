import type { INestApplication } from '@nestjs/common';
import type {
  ApprovalCard,
  AskResponse,
  AssistantConversationView,
  ComplianceView,
  LeaveBalanceView,
  LeaveRequestView,
  LeaveTypeView,
  PersonSummary,
  PersonTimelineView,
  ProbationDashboard,
  TeamCalendarView,
  TeamJourneysView,
  TeamTodayView,
  AttendanceDayView,
} from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_ACCESS_ANSWER, NO_DATA_ANSWER } from '../src/assistant/assistant.service.js';
import { LLM, type ScriptedLlm } from '../src/assistant/llm.js';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only. Maran manages Ezhil and Ilango; Oviya manages Sudha (another team). Pari
// is on probation in Maran's team; Kumar left this year.
const U = {
  admin: '00000000-0000-4000-8000-000000645001',
  hr: '00000000-0000-4000-8000-000000645002',
  mgr: '00000000-0000-4000-8000-000000645003',
  ezhil: '00000000-0000-4000-8000-000000645004',
  ilango: '00000000-0000-4000-8000-000000645005',
  other: '00000000-0000-4000-8000-000000645006',
  sudha: '00000000-0000-4000-8000-000000645007',
};
type Who = keyof typeof U;
const email = (id: string) => `${id}@test.ipro.test`;
const today = businessDate(new Date());
const d = (n: number) => addDays(today, n);
const year = Number(today.slice(0, 4));
const month = today.slice(0, 7);
/** This week's Monday: compliance weeks start on Monday. */
const monday = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
let llm: ScriptedLlm;
const agents: Record<string, ReturnType<typeof as>> = {};
type Hire = { personId: string; engagementId: string; employeeCode: string };
const p = {} as Record<
  'mgr' | 'ezhil' | 'ilango' | 'other' | 'sudha' | 'hr' | 'pari' | 'kumar',
  Hire
>;
let types: LeaveTypeView[];

const get = async <T>(who: Who, path: string) =>
  (await agents[who]!.get(path).expect(200)).body as T;
const ask = async (who: Who, text: string, conversationId?: string) =>
  (
    await agents[who]!.post('/api/assistant/ask', {
      text,
      ...(conversationId ? { conversationId } : {}),
    }).expect(200)
  ).body as AskResponse;

async function hire(
  name: string,
  userId: string | null,
  manager?: string,
  joiningDate = '2024-01-08',
): Promise<Hire> {
  const res = await agents
    .hr!.post('/api/people', {
      person: { legalName: name },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        workEmail: email(userId ?? `${name.replace(/\W/g, '').toLowerCase()}-645`),
        joiningDate,
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
  tenant = await newTenant(pool, 'Ask iPro tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Ai Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Ai HR', ['employee', 'hr']);
  await addUser(db, tenant, U.mgr, 'Ai Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.ezhil, 'Ai Ezhil', ['employee']);
  await addUser(db, tenant, U.ilango, 'Ai Ilango', ['employee']);
  await addUser(db, tenant, U.other, 'Ai Other', ['employee', 'manager']);
  await addUser(db, tenant, U.sudha, 'Ai Sudha', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  llm = app.get<ScriptedLlm>(LLM);
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  p.hr = await hire('Hema HR', U.hr);
  p.mgr = await hire('Maran Manager', U.mgr);
  p.other = await hire('Oviya Other', U.other);
  p.ezhil = await hire('Ezhil Elango', U.ezhil, p.mgr.engagementId);
  p.ilango = await hire('Ilango Iniyan', U.ilango, p.mgr.engagementId);
  p.sudha = await hire('Sudha Selvam', U.sudha, p.other.engagementId);
  // Pari's six-month probation ends in about 20 days.
  p.pari = await hire('Pari Probation', null, p.mgr.engagementId, addDays(d(20), -182));
  p.kumar = await hire('Kumar Left', null, p.mgr.engagementId, '2024-02-01');
  await pool.query(
    `update engagement set confirmation_date = '2024-07-08' where id = any($1::uuid[])`,
    [[p.hr, p.mgr, p.other, p.ezhil, p.ilango, p.sudha, p.kumar].map((h) => h.engagementId)],
  );
  await pool.query(
    `update engagement set status = 'exited', last_working_date = $2 where id = $1`,
    [p.kumar.engagementId, `${year}-01-31`],
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
      personIds: [p.hr, p.mgr, p.other, p.ezhil, p.ilango, p.sudha].map((h) => h.personId),
      shiftId: shift.body.id,
      effectiveFrom: '2024-01-08',
      reason: 'Test shift',
    })
    .expect(201);
  types = await get<LeaveTypeView[]>('ezhil', '/api/leave-types');
  const csv = [
    'employee_code,leave_type,balance',
    ...[p.hr, p.mgr, p.ezhil, p.ilango, p.sudha].flatMap((h, i) => [
      `${h.employeeCode},CL,${3 + i}`,
      `${h.employeeCode},EL,${7 + i * 1.5}`,
    ]),
  ].join('\n');
  await agents
    .hr!.post('/api/leave/balances/import', { csv, asOf: d(-1), commit: true })
    .expect(200);
  const cl = types.find((t) => t.code === 'CL')!.id;
  // Ezhil asks for two days; Ilango one, which Maran approves; Sudha one in the other team.
  await agents
    .ezhil!.post('/api/leave/requests', {
      leaveTypeId: cl,
      from: d(10),
      to: d(11),
      reason: 'Family',
    })
    .expect(201);
  await agents
    .ilango!.post('/api/leave/requests', {
      leaveTypeId: cl,
      from: d(10),
      to: d(10),
      reason: 'Errand',
    })
    .expect(201);
  await agents
    .sudha!.post('/api/leave/requests', {
      leaveTypeId: cl,
      from: d(12),
      to: d(12),
      reason: 'Errand',
    })
    .expect(201);
  const ilangoCard = (await get<ApprovalCard[]>('mgr', '/api/approvals')).find(
    (c) => c.subject.personId === p.ilango.personId,
  )!;
  await agents.mgr!.post(`/api/approvals/${ilangoCard.approvalId}/approve`, {}).expect(201);
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

/** One question of the acceptance set: the tool a model would call, and the report it must match. */
interface Question {
  who: Who;
  text: string;
  tool: string;
  input: () => Record<string, unknown>;
  /** The figure the answer states, read from the tool's result. */
  figure: (result: never) => string | number;
  /** The same figure from the matching report or screen, read by the same user. */
  report: () => Promise<string | number>;
}

const balanceOf = (rows: LeaveBalanceView[], code: string) =>
  rows.find((b) => b.leaveType.code === code)!.balance;
const toolBalance = (code: string) => (r: { balances: { code: string; balance: number }[] }) =>
  r.balances.find((b) => b.code === code)!.balance;
const onLeaveOn = (view: TeamCalendarView, date: string) =>
  view.people.filter((x) => x.days.find((day) => day.date === date)?.leave).length;
const statusCount = (rows: AttendanceDayView[]) => rows.filter((r) => r.status).length;

function questions(): Question[] {
  const qs: Question[] = [];
  // Self: own balances (8).
  for (const who of ['ezhil', 'ilango', 'mgr', 'hr'] as const) {
    for (const code of ['CL', 'EL']) {
      qs.push({
        who,
        text: `How many ${code} days do I have left? (${who})`,
        tool: 'my_leave_balances',
        input: () => ({ year }),
        figure: toolBalance(code) as never,
        report: async () =>
          balanceOf(await get(who, `/api/people/${p[who].personId}/leave?year=${year}`), code),
      });
    }
  }
  // Team and HR: someone else's balance (6).
  for (const [who, of, code] of [
    ['mgr', 'ezhil', 'CL'],
    ['mgr', 'ezhil', 'EL'],
    ['mgr', 'ilango', 'CL'],
    ['mgr', 'ilango', 'EL'],
    ['hr', 'sudha', 'CL'],
    ['hr', 'ezhil', 'EL'],
  ] as const) {
    qs.push({
      who,
      text: `What is ${of}'s ${code} balance? (${who})`,
      tool: 'person_leave_balances',
      input: () => ({ personId: p[of].personId, year }),
      figure: toolBalance(code) as never,
      report: async () =>
        balanceOf(await get(who, `/api/people/${p[of].personId}/leave?year=${year}`), code),
    });
  }
  // Self: own requests (4).
  for (const who of ['ezhil', 'ilango'] as const) {
    qs.push({
      who,
      text: `How many leave days have I asked for this year? (${who})`,
      tool: 'my_leave_requests',
      input: () => ({ year }),
      figure: ((r: { days: number; status: string }[]) =>
        r.filter((x) => x.status !== 'cancelled').reduce((n, x) => n + x.days, 0)) as never,
      report: async () =>
        (await get<LeaveRequestView[]>(who, `/api/leave/requests/mine?year=${year}`))
          .filter((x) => x.status !== 'cancelled')
          .reduce((n, x) => n + x.days, 0),
    });
    qs.push({
      who,
      text: `How many of my leave requests are still waiting? (${who})`,
      tool: 'my_leave_requests',
      input: () => ({ year }),
      figure: ((r: { status: string }[]) =>
        r.filter((x) => x.status === 'applied').length) as never,
      report: async () =>
        (await get<LeaveRequestView[]>(who, `/api/leave/requests/mine?year=${year}`)).filter(
          (x) => x.status === 'applied',
        ).length,
    });
  }
  // Approvals waiting (3).
  for (const who of ['mgr', 'other', 'hr'] as const) {
    qs.push({
      who,
      text: `How many approvals are waiting for me? (${who})`,
      tool: 'my_approvals',
      input: () => ({}),
      figure: ((r: { count: number }) => r.count) as never,
      report: async () => (await get<ApprovalCard[]>(who, '/api/approvals')).length,
    });
  }
  // Team: who is off on a date (6).
  for (const [who, scope, n] of [
    ['mgr', 'team', 10],
    ['mgr', 'team', 11],
    ['mgr', 'team', 12],
    ['mgr', 'team', 30],
    ['hr', 'all', 10],
    ['hr', 'all', 12],
  ] as const) {
    qs.push({
      who,
      text: `How many people are on leave on ${d(n)}? (${who} ${scope})`,
      tool: 'team_on_date',
      input: () => ({ date: d(n), scope }),
      figure: ((r: { onLeaveCount: number }) => r.onLeaveCount) as never,
      report: async () =>
        onLeaveOn(
          await get(who, `/api/hybrid/team-calendar?month=${d(n).slice(0, 7)}&scope=${scope}`),
          d(n),
        ),
    });
  }
  // Team today (3).
  for (const status of ['leave', 'not_checked_in', 'office'] as const) {
    qs.push({
      who: 'mgr',
      text: `How many of my team are ${status.replace(/_/g, ' ')} today?`,
      tool: 'team_today',
      input: () => ({ scope: 'team' }),
      figure: ((r: { counts: Record<string, number> }) => r.counts[status] ?? 0) as never,
      report: async () =>
        (await get<TeamTodayView>('mgr', '/api/hybrid/team-today?scope=team')).counts[status] ?? 0,
    });
  }
  // Hybrid compliance (3).
  for (const [who, scope, from] of [
    ['mgr', 'team', addDays(monday, -28)],
    ['mgr', 'team', addDays(monday, -56)],
    ['hr', 'all', addDays(monday, -28)],
  ] as const) {
    qs.push({
      who,
      text: `How many weeks were below the hybrid policy since ${from}? (${who})`,
      tool: 'hybrid_compliance',
      input: () => ({ from, to: monday, scope }),
      figure: ((r: { belowPolicy: unknown[] }) => r.belowPolicy.length) as never,
      report: async () =>
        (
          await get<ComplianceView>(
            who,
            `/api/hybrid/compliance?from=${from}&to=${monday}&scope=${scope}`,
          )
        ).people.flatMap((x) => x.weeks.filter((w) => !w.met)).length,
    });
  }
  // Attendance (3).
  for (const [who, of, m] of [
    ['ezhil', null, month],
    ['ezhil', null, d(-35).slice(0, 7)],
    ['mgr', 'ezhil', month],
  ] as const) {
    qs.push({
      who,
      text: `How many days of attendance are recorded for ${of ?? 'me'} in ${m}? (${who})`,
      tool: 'attendance_month',
      input: () => (of ? { month: m, personId: p[of].personId } : { month: m }),
      figure: ((r: { days: unknown[] }) => r.days.length) as never,
      report: async () =>
        statusCount(await get(who, `/api/people/${p[of ?? who].personId}/attendance?month=${m}`)),
    });
  }
  // Probation (3).
  for (const [who, key] of [
    ['hr', 'dueSoon'],
    ['hr', 'overdue'],
    ['mgr', 'dueSoon'],
  ] as const) {
    qs.push({
      who,
      text: `How many probations are ${key === 'dueSoon' ? 'ending this month' : 'overdue'}? (${who})`,
      tool: 'probation_dashboard',
      input: () => ({}),
      figure: ((r: Record<string, unknown[]>) => r[key]!.length) as never,
      report: async () =>
        (await get<ProbationDashboard>(who, '/api/probation/dashboard'))[key].length,
    });
  }
  // People (6).
  for (const [who, of, field] of [
    ['hr', 'ezhil', 'employeeCode'],
    ['hr', 'sudha', 'manager'],
    ['hr', 'ilango', 'joiningDate'],
    ['mgr', 'ezhil', 'employeeCode'],
    ['mgr', 'ilango', 'manager'],
  ] as const) {
    const name = { ezhil: 'Ezhil', sudha: 'Sudha', ilango: 'Ilango', pari: 'Pari' }[of];
    qs.push({
      who,
      text: `What is ${name}'s ${field}? (${who})`,
      tool: 'find_people',
      input: () => ({ query: name }),
      figure: ((r: Record<string, unknown>[]) => String(r[0]![field])) as never,
      report: async () => {
        const row = (await get<PersonSummary[]>(who, `/api/people?q=${name}`))[0]!;
        return field === 'manager' ? row.manager!.name : String(row[field]);
      },
    });
  }
  // Journeys (3).
  for (const [who, of] of [
    ['hr', 'ezhil'],
    ['mgr', 'pari'],
    ['ezhil', 'ezhil'],
  ] as const) {
    qs.push({
      who,
      text: `When did ${of} join, per their journey? (${who})`,
      tool: 'person_journey',
      input: () => ({ personId: p[of].personId }),
      figure: ((r: { person: { joiningDate: string } }) => r.person.joiningDate) as never,
      report: async () =>
        (await get<PersonTimelineView>(who, `/api/people/${p[of].personId}/timeline`)).person
          .joiningDate,
    });
  }
  // Joiners and leavers (3).
  for (const [who, scope, kind] of [
    ['hr', 'all', 'joiners'],
    ['hr', 'all', 'leavers'],
    ['mgr', 'team', 'leavers'],
  ] as const) {
    const from = `${year}-01-01`;
    qs.push({
      who,
      text: `How many ${kind} this year? (${who} ${scope})`,
      tool: 'joiners_and_leavers',
      input: () => ({ from, to: today, scope }),
      figure: ((r: Record<string, number>) => r[kind]!) as never,
      report: async () => {
        const v = await get<TeamJourneysView>(
          who,
          `/api/journeys/team?scope=${scope}&from=${from}&to=${today}&exited=true`,
        );
        return kind === 'joiners'
          ? v.people.filter((x) => x.joiningDate >= from && x.joiningDate <= today).length
          : v.people.filter(
              (x) =>
                x.status === 'exited' &&
                x.lastWorkingDate !== null &&
                x.lastWorkingDate >= from &&
                x.lastWorkingDate <= today,
            ).length;
      },
    });
  }
  return qs;
}

describe('Ask iPro answers the acceptance set from iPro’s own queries (slice 12 done-when #1)', () => {
  const set = questions();

  it('has 50 questions across self, team, HR and people', () => {
    expect(set).toHaveLength(50);
    expect(new Set(set.map((q) => q.tool)).size).toBe(12);
  });

  it.each(set.map((q, i) => [i + 1, q.text, q] as const))('%i. %s', async (_n, _text, q) => {
    llm.script(new RegExp(`^${q.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), [
      { tool: q.tool, input: q.input() },
      { text: (results) => `Answer: ${q.figure(results[0] as never)}` },
    ]);
    const reply = await ask(q.who, q.text);
    expect(reply.answer.text).toBe(`Answer: ${await q.report()}`);
    expect(reply.answer.sources.length).toBeGreaterThan(0);
  });
});

describe('runs as the user (slice 12 done-when #2)', () => {
  it('a manager asking about someone outside their team gets a refusal, not data', async () => {
    llm.script(/^What is Sudha's leave balance\?$/, [
      { tool: 'person_leave_balances', input: { personId: p.sudha.personId, year } },
      { text: (r) => `Sudha has ${JSON.stringify(r[0])}` },
    ]);
    const reply = await ask('mgr', "What is Sudha's leave balance?");
    expect(reply.answer.text).toBe(NO_ACCESS_ANSWER);
    expect(reply.answer.sources).toEqual([]);
  });

  it('a manager can’t find people outside their scope either', async () => {
    llm.script(/^Find Sudha$/, [
      { tool: 'find_people', input: { query: 'Sudha' } },
      { text: (r) => `Found ${(r[0] as unknown[]).length}` },
    ]);
    expect((await ask('mgr', 'Find Sudha')).answer.text).toBe(
      `Found ${(await get<PersonSummary[]>('mgr', '/api/people?q=Sudha')).length}`,
    );
  });

  it('an employee can’t use HR’s probation view', async () => {
    llm.script(/^Probations due\?$/, [
      { tool: 'probation_dashboard', input: {} },
      { text: 'There are 3.' },
    ]);
    expect((await ask('ezhil', 'Probations due?')).answer.text).toBe(NO_ACCESS_ANSWER);
  });
});

describe('numbers come from the system', () => {
  it('a figure with no lookup behind it is not shown', async () => {
    llm.script(/^How many people work here\?$/, [{ text: 'About 150 people.' }]);
    expect((await ask('hr', 'How many people work here?')).answer.text).toBe(NO_DATA_ANSWER);
  });

  it('a plain reply without figures is fine', async () => {
    llm.script(/^Hello$/, [{ text: 'Hi! Ask me about leave, attendance or your team.' }]);
    expect((await ask('ezhil', 'Hello')).answer.text).toBe(
      'Hi! Ask me about leave, attendance or your team.',
    );
  });
});

describe('conversations', () => {
  it('keeps the conversation for its owner only, with the question first', async () => {
    llm.script(/^Who am I\?$/, [{ text: 'You are signed in to iPro.' }]);
    const first = await ask('ezhil', 'Who am I?');
    llm.script(/^And today\?$/, [{ text: 'Nothing new today.' }]);
    await ask('ezhil', 'And today?', first.conversationId);
    // The follow-up was sent with the earlier question and answer.
    const last = llm.requests.at(-1)!;
    expect(last.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const view = await get<AssistantConversationView>(
      'ezhil',
      `/api/assistant/conversations/${first.conversationId}`,
    );
    expect(view.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Who am I?'],
      ['assistant', 'You are signed in to iPro.'],
      ['user', 'And today?'],
      ['assistant', 'Nothing new today.'],
    ]);
    await agents.ilango!.get(`/api/assistant/conversations/${first.conversationId}`).expect(404);
    await agents
      .ilango!.post('/api/assistant/ask', { text: 'Hi', conversationId: first.conversationId })
      .expect(404);
  });

  it('opens a person’s timeline next to the answer', async () => {
    llm.script(/^Show Ezhil's journey$/, [
      { tool: 'person_journey', input: { personId: p.ezhil.personId } },
      { text: 'Here is Ezhil’s journey.' },
    ]);
    const reply = await ask('hr', "Show Ezhil's journey");
    expect(reply.answer.open).toEqual({
      kind: 'timeline',
      personId: p.ezhil.personId,
      name: 'Ezhil Elango',
    });
  });

  it('writes an audit row for each question and answer, with no text in it', async () => {
    const reply = await ask('ezhil', 'Hello');
    const { rows } = await pool.query(
      `select action, table_name, field_changes from audit_log where record_id = $1`,
      [reply.answer.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'create', table_name: 'assistant_message' });
    expect(JSON.stringify(rows[0].field_changes)).not.toContain('Hi!');
  });
});
