import type { INestApplication } from '@nestjs/common';
import type { ApprovalCard, LeaveTypeView } from '@ipro/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { BOT_ISSUER, BOT_KEYS } from '../src/notify/bot-auth.js';
import { TestBotKeys } from '../src/notify/bot-test-keys.js';
import {
  MAIL_CHANNEL,
  TEAMS_CHANNEL,
  type FakeMail,
  type FakeTeams,
} from '../src/notify/channels.js';
import { DeliveryService } from '../src/notify/delivery.service.js';
import { MilestonesService } from '../src/notify/milestones.service.js';
import { APPROVE_VERB, REJECT_VERB } from '../src/notify/teams-cards.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only. Kavin manages Lata and Mukil; Nila is in another team. Tara joins soon.
const U = {
  admin: '00000000-0000-4000-8000-000000635001',
  hr: '00000000-0000-4000-8000-000000635002',
  mgr: '00000000-0000-4000-8000-000000635003',
  lata: '00000000-0000-4000-8000-000000635004',
  mukil: '00000000-0000-4000-8000-000000635005',
  other: '00000000-0000-4000-8000-000000635006',
  nila: '00000000-0000-4000-8000-000000635007',
};
const OID = (id: string) => `aad-${id.slice(-6)}`;
const BOT_APP_ID = '00000000-0000-4000-8000-00000000b071';
const SERVICE_URL = 'https://smba.trafficmanager.net/in/';
const email = (id: string) => `${id}@test.ipro.test`;
const today = businessDate(new Date());
const d = (n: number) => addDays(today, n);

const { pool, db } = testDb();
const keys = new TestBotKeys();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
let teams: FakeTeams;
let mail: FakeMail;
const agents: Record<string, ReturnType<typeof as>> = {};
type Hire = { personId: string; engagementId: string; employeeCode: string };
const p = {} as Record<'mgr' | 'lata' | 'mukil' | 'other' | 'nila', Hire>;
let types: LeaveTypeView[];

const token = () => {
  const at = Math.floor(Date.now() / 1000);
  return keys.sign({
    iss: BOT_ISSUER,
    aud: BOT_APP_ID,
    exp: at + 600,
    nbf: at - 60,
    serviceurl: SERVICE_URL,
  });
};
const activity = (userId: string, extra: Record<string, unknown>) => ({
  serviceUrl: SERVICE_URL,
  channelId: 'msteams',
  from: { id: `29:${userId}`, aadObjectId: OID(userId) },
  recipient: { id: `28:${BOT_APP_ID}` },
  conversation: { id: `a:conv-${userId}`, conversationType: 'personal', tenantId: 'test-tenant' },
  ...extra,
});
const bot = (body: object, auth: string | null = `Bearer ${token()}`) => {
  const req = request(app.getHttpServer()).post('/api/teams/messages').send(body);
  return auth ? req.set('authorization', auth) : req;
};
const install = (userId: string) =>
  bot(activity(userId, { type: 'installationUpdate', action: 'add' })).expect(200);
const press = (userId: string, verb: string, data: Record<string, unknown>) =>
  bot(
    activity(userId, {
      type: 'invoke',
      name: 'adaptiveCard/action',
      value: { action: { type: 'Action.Execute', verb, data } },
    }),
  ).expect(200);
const deliver = () => runWithContext({ tenantId: tenant }, () => app.get(DeliveryService).run());
const cards = async (who: string) =>
  (await agents[who]!.get('/api/approvals').expect(200)).body as ApprovalCard[];
const applyLeave = (who: string, day: string) =>
  agents[who]!.post('/api/leave/requests', {
    leaveTypeId: types.find((t) => t.code === 'CL')!.id,
    from: day,
    to: day,
    reason: 'Personal work',
  }).expect(201);
const deliveries = async (userId: string) =>
  (
    await pool.query(
      `select d.channel, d.status, n.kind from notification_delivery d
         join notification n on n.id = d.notification_id
        where d.recipient_user_id = $1 order by d.created_at`,
      [userId],
    )
  ).rows as { channel: string; status: string; kind: string }[];

async function hire(
  name: string,
  userId: string | null,
  manager?: string,
  joiningDate = '2024-01-08',
) {
  const res = await agents
    .hr!.post('/api/people', {
      person: { legalName: name },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        workEmail: email(userId ?? `${name.replace(/\W/g, '').toLowerCase()}-635`),
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
  tenant = await newTenant(pool, 'Teams tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Tm Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Tm HR', ['employee', 'hr']);
  await addUser(db, tenant, U.mgr, 'Tm Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.lata, 'Tm Lata', ['employee']);
  await addUser(db, tenant, U.mukil, 'Tm Mukil', ['employee']);
  await addUser(db, tenant, U.other, 'Tm Other', ['employee', 'manager']);
  await addUser(db, tenant, U.nila, 'Tm Nila', ['employee']);
  app = await createTestApp(
    { TENANT_ID: tenant, TEAMS_BOT_APP_ID: BOT_APP_ID, APP_URL: 'https://ipro.example.test' },
    [{ provide: BOT_KEYS, useValue: keys }],
  );
  teams = app.get<FakeTeams>(TEAMS_CHANNEL);
  mail = app.get<FakeMail>(MAIL_CHANNEL);
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  // Linked to Entra after the dev sign-in: Teams finds people by their Entra object id.
  for (const id of Object.values(U)) {
    await pool.query(`update app_user set entra_object_id = $2 where id = $1`, [id, OID(id)]);
  }
  p.mgr = await hire('Kavin Manager', U.mgr);
  p.other = await hire('Oli Other', U.other);
  p.lata = await hire('Lata Lakshmi', U.lata, p.mgr.engagementId);
  p.mukil = await hire('Mukil Mani', U.mukil, p.mgr.engagementId);
  p.nila = await hire('Nila Nathan', U.nila, p.other.engagementId);
  await pool.query(
    `update engagement set confirmation_date = '2024-07-08' where id = any($1::uuid[])`,
    [[p.lata, p.mukil, p.nila].map((h) => h.engagementId)],
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
      personIds: [p.lata, p.mukil, p.nila].map((h) => h.personId),
      shiftId: shift.body.id,
      effectiveFrom: '2024-01-08',
      reason: 'Test shift',
    })
    .expect(201);
  types = (await agents.lata!.get('/api/leave-types').expect(200)).body;
  const csv = [
    'employee_code,leave_type,balance',
    ...[p.lata, p.mukil, p.nila].map((h) => `${h.employeeCode},CL,5`),
  ].join('\n');
  await agents
    .hr!.post('/api/leave/balances/import', { csv, asOf: d(-1), commit: true })
    .expect(200);
  // Lata and Mukil were told about their own records; only the approvals below matter.
  await deliver();
  teams.sent.length = 0;
  mail.sent.length = 0;
}, 120_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('the Teams bot endpoint (decision #87)', () => {
  it('refuses activities without a valid Bot Framework token', async () => {
    await bot(activity(U.mgr, { type: 'installationUpdate', action: 'add' }), null).expect(401);
    await bot(
      activity(U.mgr, { type: 'installationUpdate', action: 'add' }),
      'Bearer x.y.z',
    ).expect(401);
  });

  it('learns where to reach someone when the app is installed for them', async () => {
    await install(U.mgr);
    await install(U.other);
    const { rows } = await pool.query(
      `select service_url, conversation_id from teams_conversation where user_id = $1`,
      [U.mgr],
    );
    expect(rows).toEqual([{ service_url: SERVICE_URL, conversation_id: `a:conv-${U.mgr}` }]);
  });
});

describe('Teams delivery and actionable approval cards (slice 11 done-when #3)', () => {
  let lataCard: ApprovalCard;
  let mukilCard: ApprovalCard;

  it('an approval request reaches the approver in Teams as a card with the inbox context', async () => {
    await applyLeave('lata', d(20));
    await applyLeave('mukil', d(21));
    const result = await deliver();
    expect(result.sent).toBeGreaterThanOrEqual(2);
    const mine = await cards('mgr');
    lataCard = mine.find((c) => c.subject.personId === p.lata.personId)!;
    mukilCard = mine.find((c) => c.subject.personId === p.mukil.personId)!;
    const toManager = teams.sent.filter((s) => s.to.conversationId === `a:conv-${U.mgr}`);
    const lataTeams = JSON.stringify(
      toManager.find((s) => JSON.stringify(s.card).includes(lataCard.approvalId))!.card,
    );
    expect(lataTeams).toContain(APPROVE_VERB);
    expect(lataTeams).toContain('Casual leave balance');
    expect(lataTeams).toContain('Also off');
    expect(lataTeams).toContain('Policy');
    expect((await deliveries(U.mgr)).filter((x) => x.kind === 'approval_requested')).toEqual([
      { channel: 'teams', status: 'sent', kind: 'approval_requested' },
      { channel: 'teams', status: 'sent', kind: 'approval_requested' },
    ]);
  });

  it('approving from Teams is recorded exactly like approving in iPro', async () => {
    const reply = await press(U.mgr, APPROVE_VERB, { approvalId: lataCard.approvalId });
    expect(reply.body).toMatchObject({
      statusCode: 200,
      type: 'application/vnd.microsoft.card.adaptive',
    });
    expect(JSON.stringify(reply.body.value)).toContain('Approved by you.');
    await agents.mgr!.post(`/api/approvals/${mukilCard.approvalId}/approve`, {}).expect(201);

    const audit = async (approvalId: string) =>
      (
        await pool.query(
          `select action, table_name, field_changes, created_by, subject_person_id is not null as has_subject
             from audit_log where record_id = $1`,
          [approvalId],
        )
      ).rows;
    const viaTeams = await audit(lataCard.approvalId);
    expect(viaTeams).toHaveLength(1);
    expect(viaTeams).toEqual(await audit(mukilCard.approvalId));
    expect(viaTeams[0]).toMatchObject({ created_by: U.mgr, table_name: 'approval' });
    const { rows } = await pool.query(`select decided_by, decision from approval where id = $1`, [
      lataCard.approvalId,
    ]);
    expect(rows[0]).toEqual({ decided_by: U.mgr, decision: 'approved' });
  });

  it('uses the same approver check: someone else can’t decide it from Teams', async () => {
    await applyLeave('nila', d(22));
    const nilaCard = (await cards('other')).find((c) => c.subject.personId === p.nila.personId)!;
    const reply = await press(U.mgr, APPROVE_VERB, { approvalId: nilaCard.approvalId });
    expect(JSON.stringify(reply.body.value)).toContain('You can’t decide this one.');
    expect((await cards('other')).map((c) => c.approvalId)).toContain(nilaCard.approvalId);
  });

  it('rejecting from Teams needs a comment, which the requester sees', async () => {
    const nilaCard = (await cards('other')).find((c) => c.subject.personId === p.nila.personId)!;
    const empty = await press(U.other, REJECT_VERB, {
      approvalId: nilaCard.approvalId,
      comment: ' ',
    });
    expect(JSON.stringify(empty.body.value)).toContain('Add a comment');
    const done = await press(U.other, REJECT_VERB, {
      approvalId: nilaCard.approvalId,
      comment: 'Please move it a week',
    });
    expect(JSON.stringify(done.body.value)).toContain('Returned to the requester');
    const { rows } = await pool.query(`select decision, comment from approval where id = $1`, [
      nilaCard.approvalId,
    ]);
    expect(rows[0]).toEqual({ decision: 'rejected', comment: 'Please move it a week' });
  });

  it('a decided card answers with what happened, not a second decision', async () => {
    const again = await press(U.mgr, APPROVE_VERB, { approvalId: lataCard.approvalId });
    expect(JSON.stringify(again.body.value)).toContain('This step has already been decided');
  });
});

describe('email: the fallback and the opt-in', () => {
  it('someone Teams can’t reach gets the notification by email instead', async () => {
    // Lata has no Teams conversation: her "approved" update goes by email.
    await deliver();
    const lata = (await deliveries(U.lata)).filter((x) => x.kind === 'workflow_approved');
    expect(lata).toEqual([
      { channel: 'teams', status: 'unreachable', kind: 'workflow_approved' },
      { channel: 'email', status: 'sent', kind: 'workflow_approved' },
    ]);
    const message = mail.sent.find(
      (m) => m.to === email(U.lata) && m.subject.startsWith('Approved'),
    )!;
    expect(message.html).toContain('https://ipro.example.test/requests/');
    expect(message.html).toContain('notification settings');
  });

  it('those who ask for a copy get Teams and email', async () => {
    await install(U.mukil);
    await agents
      .mukil!.put('/api/notification-preferences', { off: [], emailCopy: true })
      .expect(200);
    await applyLeave('mukil', d(30));
    const card = (await cards('mgr')).find((c) => c.subject.personId === p.mukil.personId)!;
    await press(U.mgr, APPROVE_VERB, { approvalId: card.approvalId });
    await deliver();
    const latest = (await deliveries(U.mukil))
      .filter((x) => x.kind === 'workflow_approved')
      .slice(-2);
    expect(latest.map((x) => [x.channel, x.status]).sort()).toEqual([
      ['email', 'sent'],
      ['teams', 'sent'],
    ]);
  });

  it('a send that fails retries later; Teams being down doesn’t lose it', async () => {
    teams.failNext = 'transient';
    await applyLeave('lata', d(31));
    await deliver();
    const pending = (await deliveries(U.mgr)).filter((x) => x.status === 'pending');
    expect(pending).toHaveLength(1);
    // The retry is due a minute later.
    await runWithContext({ tenantId: tenant }, () =>
      app.get(DeliveryService).run(new Date(Date.now() + 2 * 60_000)),
    );
    expect((await deliveries(U.mgr)).filter((x) => x.status === 'pending')).toHaveLength(0);
  });
});

describe('date-driven notices at 09:00 (decision #87)', () => {
  const run = () => runWithContext({ tenantId: tenant }, () => app.get(MilestonesService).run());
  const kinds = async (userId: string, kind: string) =>
    (
      await pool.query(
        `select title from notification where recipient_user_id = $1 and kind = $2`,
        [userId, kind],
      )
    ).rows.map((r) => r.title as string);

  it('joining in 7 days and tomorrow: HR and the manager, once each', async () => {
    await hire('Tara Tomorrow', null, p.mgr.engagementId, d(1));
    await hire('Selvan Seven', null, p.mgr.engagementId, d(7));
    await run();
    await run();
    expect(await kinds(U.mgr, 'joining_soon')).toEqual(
      expect.arrayContaining([
        'Tara Tomorrow joins tomorrow',
        expect.stringMatching(/^Selvan Seven joins on /),
      ]),
    );
    expect(await kinds(U.mgr, 'joining_soon')).toHaveLength(2);
    expect(await kinds(U.hr, 'joining_soon')).toHaveLength(2);
  });

  it('a work anniversary: the person and their manager', async () => {
    await pool.query(`update engagement set joining_date = $2 where id = $1`, [
      p.lata.engagementId,
      `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`,
    ]);
    await run();
    expect(await kinds(U.lata, 'work_anniversary')).toEqual([
      'Happy work anniversary: 2 years today',
    ]);
    expect(await kinds(U.mgr, 'work_anniversary')).toEqual([
      'Lata Lakshmi completes 2 years today',
    ]);
  });

  it('last working day in 7 days: the person, their manager and HR', async () => {
    // The exit flows are tested elsewhere; here Mukil is simply serving notice.
    await pool.query(
      `update engagement set status = 'on_notice', last_working_date = $2 where id = $1`,
      [p.mukil.engagementId, d(7)],
    );
    await run();
    expect(await kinds(U.mukil, 'last_day_soon')).toEqual([
      expect.stringMatching(/^Your last working day is /),
    ]);
    expect(await kinds(U.mgr, 'last_day_soon')).toEqual([
      expect.stringMatching(/^Mukil Mani’s last working day is /),
    ]);
    expect(await kinds(U.hr, 'last_day_soon')).toHaveLength(1);
  });
});
