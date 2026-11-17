import type { INestApplication } from '@nestjs/common';
import type { AskResponse, PolicyClausesView, PolicyStatusView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DONT_KNOW_ANSWER } from '../src/assistant/assistant.service.js';
import { teamsChatLink } from '../src/assistant/hr-contact.js';
import { LLM, type ScriptedLlm } from '../src/assistant/llm.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { PoliciesService } from '../src/policies/policies.service.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { blankPdf, policyDocx, policyPdf } from './policy-files.js';
import { createTestApp } from './test-app.js';

// Synthetic policies and people only. Ezhil is in Engineering; the HR handbook applies to People Ops.
const U = {
  admin: '00000000-0000-4000-8000-000000655001',
  hr: '00000000-0000-4000-8000-000000655002',
  ezhil: '00000000-0000-4000-8000-000000655003',
};
const email = (id: string) => `${id}@test.ipro.test`;

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
let llm: ScriptedLlm;
const agents: Record<string, ReturnType<typeof as>> = {};
const ids = {} as Record<'leave' | 'notice' | 'handbook' | 'scan', string>;

async function createPolicy(code: string, title: string, appliesTo: object = {}) {
  const res = await agents
    .admin!.post('/api/policies', { code, title, appliesTo, requiresAcknowledgement: false })
    .expect(201);
  return (res.body as PolicyStatusView).policyId;
}

const publish = (policyId: string, file: Buffer, filename: string, contentType: string) =>
  agents
    .admin!.post(`/api/policies/${policyId}/versions`)
    .field('effectiveFrom', '2026-01-01')
    .attach('file', file, { filename, contentType });

const ask = async (who: string, text: string) =>
  (await agents[who]!.post('/api/assistant/ask', { text }).expect(200)).body as AskResponse;

beforeAll(async () => {
  tenant = await newTenant(pool, 'Policy answer tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Pa Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Pa HR', ['employee', 'hr']);
  await addUser(db, tenant, U.ezhil, 'Pa Ezhil', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  llm = app.get<ScriptedLlm>(LLM);
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  await agents
    .hr!.post('/api/people', {
      person: { legalName: 'Ezhil Elango' },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        workEmail: email(U.ezhil),
        joiningDate: '2024-01-08',
      },
      assignment: {
        designationId: org.softwareEngineer,
        departmentId: org.engineering,
        locationId: org.chennai,
        bucket: 'billable',
      },
    })
    .expect(201);
  await agents
    .hr!.post('/api/people', {
      person: { legalName: 'Hema HR' },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        workEmail: email(U.hr),
        joiningDate: '2024-01-08',
      },
      assignment: {
        designationId: org.softwareEngineer,
        departmentId: org.peopleOps,
        locationId: org.chennai,
        bucket: 'administration',
      },
    })
    .expect(201);
  ids.leave = await createPolicy('LEAVE', 'Leave policy');
  ids.notice = await createPolicy('NOTICE', 'Notice policy');
  ids.handbook = await createPolicy('HRH', 'HR handbook', { departmentIds: [org.peopleOps] });
  ids.scan = await createPolicy('SCAN', 'Scanned travel policy');
}, 120_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('reading policy files into clauses (decision #89)', () => {
  it('reads a published PDF into its numbered clauses', async () => {
    const pdf = await policyPdf('Leave policy', [
      '1. Purpose. This policy sets out the leave employees may take.',
      '2. Casual leave. Employees get 12 days of casual leave a year, credited monthly.',
      '3. Earned leave. Up to 10 days of earned leave carry forward to the next year; the rest lapses.',
      '4. Sick leave. A medical certificate is needed for more than 2 days in a row.',
    ]);
    const status = (
      await publish(ids.leave, pdf, 'Leave policy.pdf', 'application/pdf').expect(201)
    ).body as PolicyStatusView;
    expect(status.current).toMatchObject({ textStatus: 'ready', clauseCount: 5 });
    const view = (await agents.ezhil!.get(`/api/policies/${ids.leave}/clauses`).expect(200))
      .body as PolicyClausesView;
    expect(view.clauses.filter((c) => c.number).map((c) => [c.number, c.heading])).toEqual([
      ['1', 'Purpose'],
      ['2', 'Casual leave'],
      ['3', 'Earned leave'],
      ['4', 'Sick leave'],
    ]);
  });

  it('reads a Word file the same way', async () => {
    const docx = policyDocx([
      'Notice policy',
      '1. Scope. This policy covers resignations.',
      '2. Notice period. Leads serve 60 days of notice; associates serve 30 days.',
    ]);
    const status = (
      await publish(
        ids.notice,
        docx,
        'Notice policy.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ).expect(201)
    ).body as PolicyStatusView;
    expect(status.current).toMatchObject({ textStatus: 'ready', clauseCount: 3 });
  });

  it('marks a file with no text, and refuses other file types', async () => {
    const status = (
      await publish(ids.scan, await blankPdf(), 'Travel scan.pdf', 'application/pdf').expect(201)
    ).body as PolicyStatusView;
    expect(status.current).toMatchObject({ textStatus: 'empty', clauseCount: 0 });
    const refused = await publish(
      ids.scan,
      Buffer.from('plain text'),
      'travel.txt',
      'text/plain',
    ).expect(400);
    expect(refused.body.message).toBe('Policies are published as PDF or Word (.docx)');
  });

  it('reads versions published before Ask iPro in the hourly run', async () => {
    const handbook = await policyPdf('HR handbook', [
      '1. Confidential files. HR keeps personnel files locked.',
      '2. Access. Only HR may open them.',
    ]);
    await publish(ids.handbook, handbook, 'HR handbook.pdf', 'application/pdf').expect(201);
    // As if published before slice 12: no clauses yet.
    const { rows } = await pool.query(`select id from policy_version where policy_id = $1`, [
      ids.handbook,
    ]);
    await pool.query(`delete from policy_clause where policy_version_id = $1`, [rows[0].id]);
    await pool.query(
      `update policy_version set text_status = 'pending', clause_count = 0 where id = $1`,
      [rows[0].id],
    );
    const read = await runWithContext({ tenantId: tenant }, () =>
      app.get(PoliciesService).readPending(),
    );
    expect(read).toBe(1);
    const view = (await agents.hr!.get(`/api/policies/${ids.handbook}/clauses`).expect(200))
      .body as PolicyClausesView;
    expect(view.textStatus).toBe('ready');
  });

  it('shows clauses only of policies that apply to the person (HR sees all)', async () => {
    await agents.ezhil!.get(`/api/policies/${ids.handbook}/clauses`).expect(403);
    await agents.hr!.get(`/api/policies/${ids.handbook}/clauses`).expect(200);
  });
});

describe('policy answers (slice 12 done-when #4)', () => {
  it('answers from the matching clause and links to it, on the reasoning model', async () => {
    llm.script(/^How many days of earned leave can I carry forward\?$/, [
      { tool: 'policy_search', input: { question: 'earned leave carry forward' } },
      {
        text: (r) => {
          const top = (r[0] as { clauses: { policy: string; clause: string; text: string }[] })
            .clauses[0]!;
          return `${top.policy} ${top.clause}: ${top.text}`;
        },
      },
    ]);
    const reply = await ask('ezhil', 'How many days of earned leave can I carry forward?');
    expect(reply.answer.text).toBe(
      'Leave policy 3: Up to 10 days of earned leave carry forward to the next year; the rest lapses.',
    );
    const view = (await agents.ezhil!.get(`/api/policies/${ids.leave}/clauses`).expect(200))
      .body as PolicyClausesView;
    const clause = view.clauses.find((c) => c.number === '3')!;
    expect(reply.answer.sources[0]).toEqual({
      label: 'Leave policy 3: Earned leave',
      link: `/policies?policy=${ids.leave}&clause=${clause.position}`,
    });
    // Lookups start on the fast model; the policy answer is written by the reasoning model.
    expect(llm.requests.slice(-2).map((r) => r.tier)).toEqual(['lookup', 'reasoning']);
  });

  it('finds clauses in Word policies too', async () => {
    llm.script(/^What is the notice period for leads\?$/, [
      { tool: 'policy_search', input: { question: 'notice period leads' } },
      {
        text: (r) =>
          (r[0] as { clauses: { clause: string; text: string }[] }).clauses
            .map((c) => `${c.clause}: ${c.text}`)
            .join(' '),
      },
    ]);
    const reply = await ask('ezhil', 'What is the notice period for leads?');
    expect(reply.answer.text).toContain('Leads serve 60 days of notice');
    expect(reply.answer.sources[0]!.label).toBe('Notice policy 2: Notice period');
  });

  it('a question no policy answers gets “I don’t know” and a Teams chat with HR', async () => {
    llm.script(/^What is the dress code\?$/, [
      { tool: 'policy_search', input: { question: 'dress code' } },
      { text: 'Smart casual, 5 days a week.' },
    ]);
    const reply = await ask('ezhil', 'What is the dress code?');
    expect(reply.answer.text).toBe(DONT_KNOW_ANSWER);
    // By default: a Teams chat with the company's HR people, the question typed in (decision #90).
    expect(reply.answer.sources).toEqual([
      {
        label: 'Chat with HR in Teams',
        link: teamsChatLink([email(U.hr)], 'What is the dress code?'),
      },
    ]);
  });

  it('the HR link is HR’s to set', async () => {
    await pool.query(
      `insert into tenant_setting (tenant_id, key, value) values ($1, 'hr_contact', $2)`,
      [tenant, JSON.stringify({ label: 'Email HR', link: 'mailto:hr@example.test' })],
    );
    llm.script(/^Can I bring my dog to office\?$/, [
      { tool: 'policy_search', input: { question: 'dog office pets' } },
      { text: 'Yes.' },
    ]);
    const reply = await ask('ezhil', 'Can I bring my dog to office?');
    expect(reply.answer.sources).toEqual([{ label: 'Email HR', link: 'mailto:hr@example.test' }]);
  });

  it('never answers from a policy that doesn’t apply to the person', async () => {
    llm.script(/^Who may open personnel files\?$/, [
      { tool: 'policy_search', input: { question: 'personnel files access' } },
      { text: 'Only HR.' },
    ]);
    expect((await ask('ezhil', 'Who may open personnel files?')).answer.text).toBe(
      DONT_KNOW_ANSWER,
    );
    expect((await ask('hr', 'Who may open personnel files?')).answer.text).toBe('Only HR.');
  });
});
