import type { INestApplication } from '@nestjs/common';
import type { ApprovalCard, NotificationView, ProbationDashboard, ReviewView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { ESIGN_PROVIDER, type FakeEsign } from '../src/esign/esign.js';
import { ReviewsService } from '../src/reviews/reviews.service.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only.
const U = {
  admin: '00000000-0000-4000-8000-000000201001',
  hr: '00000000-0000-4000-8000-000000201002',
  hrHead: '00000000-0000-4000-8000-000000201003',
  head: '00000000-0000-4000-8000-000000201004',
  mgr: '00000000-0000-4000-8000-000000201005',
  emp: '00000000-0000-4000-8000-000000201006',
  confirmed: '00000000-0000-4000-8000-000000201007',
};
const email = (id: string) => `${id}@test.ipro.test`;
const today = businessDate(new Date());
const at = (day: string) => new Date(`${day}T06:00:00+05:30`);
const ratings = { 'Quality of work': 4, Ownership: 4, Collaboration: 5, Learning: 3 };

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
let fake: FakeEsign;
let mgrEngagementId: string;
let confirmedReviewId: string;
const agents: Record<string, ReturnType<typeof as>> = {};

const sweep = (day: string) =>
  runWithContext({ tenantId: tenant }, () => app.get(ReviewsService).sweep(at(day)));
const notes = async (who: string, kind: string) =>
  ((await agents[who]!.get('/api/notifications').expect(200)).body as NotificationView[]).filter(
    (n) => n.kind === kind,
  );
const reviewOf = async (personId: string) =>
  ((await agents.mgr!.get('/api/reviews').expect(200)).body as ReviewView[]).find(
    (r) => r.person.personId === personId && r.status !== 'decided',
  );
const cardFor = async (who: string, personId: string) =>
  ((await agents[who]!.get('/api/approvals').expect(200)).body as ApprovalCard[]).find(
    (c) => c.subject.personId === personId,
  );
const engagement = async (personId: string) =>
  (
    await pool.query(
      `select status, probation_end_date::text as probation_end, confirmation_date::text as confirmed,
              last_working_date::text as last_day, notice_period_days
         from engagement where person_id = $1`,
      [personId],
    )
  ).rows[0];
const events = async (personId: string) =>
  (
    await pool.query<{ event_type: string }>(
      `select event_type from journal_event where person_id = $1 order by created_at`,
      [personId],
    )
  ).rows.map((r) => r.event_type);
const lettersOf = async (personId: string) =>
  (
    await pool.query<{ type: string; status: string }>(
      `select t.type, l.status from letter l join letter_template t on t.id = l.template_id
        where l.person_id = $1 order by l.created_at`,
      [personId],
    )
  ).rows;

/** A person on probation reporting to the manager, whose probation ends on `end`. */
async function onProbation(name: string, end: string, workEmail?: string): Promise<string> {
  const created = await agents
    .hr!.post('/api/people', {
      person: { legalName: name },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        joiningDate: '2026-05-04',
        ...(workEmail ? { workEmail } : {}),
      },
      assignment: {
        designationId: org.softwareEngineer,
        departmentId: org.engineering,
        locationId: org.chennai,
        managerEngagementId: mgrEngagementId,
        bucket: 'billable',
      },
    })
    .expect(201);
  await pool.query(`update engagement set probation_end_date = $2 where person_id = $1`, [
    created.body.personId,
    end,
  ]);
  return created.body.personId;
}

beforeAll(async () => {
  tenant = await newTenant(pool, 'Probation tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Pr Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Pr HR', ['employee', 'hr']);
  await addUser(db, tenant, U.hrHead, 'Pr HR Head', ['employee', 'hr_head']);
  await addUser(db, tenant, U.head, 'Pr Head', ['employee', 'manager']);
  await addUser(db, tenant, U.mgr, 'Pr Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.emp, 'Pr Employee', ['employee']);
  await addUser(db, tenant, U.confirmed, 'Pr Confirmed', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  fake = app.get<FakeEsign>(ESIGN_PROVIDER);
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));

  const person = (name: string, user: string, manager?: string) => ({
    person: { legalName: name },
    engagement: {
      legalEntityId: org.legalEntity,
      type: 'permanent',
      workEmail: email(user),
      joiningDate: '2024-01-08',
    },
    assignment: {
      designationId: org.softwareEngineer,
      departmentId: org.engineering,
      locationId: org.chennai,
      managerEngagementId: manager,
      bucket: 'billable',
    },
  });
  const head = await agents.hr!.post('/api/people', person('Hari Head', U.head)).expect(201);
  const mgr = await agents
    .hr!.post('/api/people', person('Mala Manager', U.mgr, head.body.engagementId))
    .expect(201);
  mgrEngagementId = mgr.body.engagementId;
  // Long-standing people are already confirmed.
  await pool.query(
    `update engagement set confirmation_date = '2024-07-08' where id = any($1::uuid[])`,
    [[head.body.engagementId, mgr.body.engagementId]],
  );
  for (const key of ['head', 'mgr'] as const) {
    agents[key] = as(app, await signIn(app, U[key]));
  }

  for (const [type, signature] of [
    ['confirmation', 'employee'],
    ['extension', 'none'],
    ['termination', 'none'],
  ] as const) {
    await agents
      .admin!.put(`/api/letter-templates/probation_${type}`, {
        name: `Probation ${type}`,
        type,
        body: `Dear {{person.legalName}}, your probation ends {{engagement.probationEndDate}}.`,
        approverRole: null,
        signature,
      })
      .expect(200);
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('reminders and escalation (done-when #1)', () => {
  const end = addDays(today, 30);
  let personId: string;

  it('opens the review 30 days before the end date and tells the manager', async () => {
    personId = await onProbation('Esha Employee', end, email(U.emp));
    expect((await sweep(addDays(end, -31))).opened).toBe(0);
    const first = await sweep(addDays(end, -30));
    expect(first.opened).toBeGreaterThanOrEqual(1);
    const review = (await reviewOf(personId))!;
    expect(review).toMatchObject({
      status: 'due',
      dueOn: end,
      reviewer: 'Pr Manager',
      overdue: false,
    });
    expect(review.competencies).toEqual(Object.keys(ratings));
    expect((await notes('mgr', 'probation_review_due')).length).toBeGreaterThanOrEqual(1);
    await sweep(addDays(end, -30));
    const count = await pool.query(`select count(*)::int as n from review where person_id = $1`, [
      personId,
    ]);
    expect(count.rows[0].n).toBe(1);
  });

  it('reminds at 14 and 7 days, once each', async () => {
    const before = (await notes('mgr', 'probation_review_reminder')).length;
    await sweep(addDays(end, -14));
    await sweep(addDays(end, -13));
    await sweep(addDays(end, -7));
    await sweep(addDays(end, -7));
    expect((await notes('mgr', 'probation_review_reminder')).length - before).toBe(2);
  });

  it('an overdue review escalates to the manager’s manager and HR, every day it stays overdue', async () => {
    await sweep(addDays(end, 1));
    await sweep(addDays(end, 1));
    expect((await notes('head', 'probation_review_overdue')).length).toBe(1);
    expect((await notes('hr', 'probation_review_overdue')).length).toBe(1);
    await sweep(addDays(end, 2));
    expect((await notes('head', 'probation_review_overdue')).length).toBe(2);
    expect((await engagement(personId)).status).toBe('active');
  });
});

describe('decisions (done-when #2)', () => {
  it('confirm: HR approves on the card; the confirmation letter goes to sign; Probation confirmed', async () => {
    const personId = await onProbation('Chetan Confirm', addDays(today, 20), email(U.confirmed));
    agents.confirmed = as(app, await signIn(app, U.confirmed));
    await sweep(today);
    const review = (await reviewOf(personId))!;
    confirmedReviewId = review.id;

    await agents.confirmed!.get(`/api/reviews/${review.id}`).expect(404);
    await agents
      .hr!.post(`/api/reviews/${review.id}/submit`, {
        recommendation: 'confirm',
        ratings,
        comments: 'Strong start',
      })
      .expect(403);
    const partial = await agents
      .mgr!.post(`/api/reviews/${review.id}/submit`, {
        recommendation: 'confirm',
        ratings: { 'Quality of work': 4 },
        comments: 'Strong start',
      })
      .expect(400);
    expect(partial.body.problems).toEqual(['Ownership', 'Collaboration', 'Learning']);

    const sent = (
      await agents
        .mgr!.post(`/api/reviews/${review.id}/submit`, {
          recommendation: 'confirm',
          ratings,
          strengths: 'Ownership of the billing module',
          comments: 'Strong start',
        })
        .expect(201)
    ).body as ReviewView;
    expect(sent.status).toBe('submitted');

    const card = (await cardFor('hr', personId))!;
    expect(card.stepLabel).toBe('HR decision');
    expect(card.changes).toEqual(
      expect.arrayContaining([
        { label: 'Recommendation', from: null, to: 'Confirm' },
        {
          label: 'Ratings',
          from: null,
          to: 'Quality of work 4/5, Ownership 4/5, Collaboration 5/5, Learning 3/5',
        },
      ]),
    );
    const requests = fake.requests.size;
    await agents.hr!.post(`/api/approvals/${card.approvalId}/approve`, {}).expect(201);

    const after = await engagement(personId);
    expect(after.confirmed).toBe(addDays(today, 21));
    expect(after.notice_period_days).toBe(60);
    expect(await events(personId)).toContain('probation_confirmed');
    expect(await lettersOf(personId)).toEqual([{ type: 'confirmation', status: 'sent' }]);
    expect(fake.requests.size).toBe(requests + 1);
  });

  it('extend: within policy only; the end date moves, an extension letter is made, and a new review opens later', async () => {
    const end = addDays(today, 15);
    const personId = await onProbation('Ezhil Extend', end);
    await sweep(today);
    const review = (await reviewOf(personId))!;
    await agents
      .mgr!.post(`/api/reviews/${review.id}/submit`, {
        recommendation: 'extend',
        ratings,
        comments: 'Needs more time on code reviews',
        newEndDate: addDays(end, 120),
      })
      .expect(400);
    await agents
      .mgr!.post(`/api/reviews/${review.id}/submit`, {
        recommendation: 'extend',
        ratings,
        comments: 'Needs more time on code reviews',
        newEndDate: addDays(end, 60),
      })
      .expect(201);
    const card = (await cardFor('hr', personId))!;
    expect(card.changes).toContainEqual({
      label: 'Probation ends',
      from: end,
      to: addDays(end, 60),
    });
    await agents.hr!.post(`/api/approvals/${card.approvalId}/approve`, {}).expect(201);

    expect((await engagement(personId)).probation_end).toBe(addDays(end, 60));
    expect(await events(personId)).toContain('probation_extended');
    expect(await lettersOf(personId)).toEqual([{ type: 'extension', status: 'ready' }]);

    // The new end date gets its own review; a second extension is beyond policy.
    await sweep(addDays(end, 30));
    const next = (await reviewOf(personId))!;
    expect(next.dueOn).toBe(addDays(end, 60));
    expect(next.extensions).toEqual({ used: 1, max: 1, maxMonths: 3 });
    await agents
      .mgr!.post(`/api/reviews/${next.id}/submit`, {
        recommendation: 'extend',
        ratings,
        comments: 'Again',
        newEndDate: addDays(end, 80),
      })
      .expect(400);
  });

  it('terminate: needs HR head; the person goes on notice to the agreed day', async () => {
    const personId = await onProbation('Tara Terminate', addDays(today, 10));
    await sweep(today);
    const review = (await reviewOf(personId))!;
    await agents
      .mgr!.post(`/api/reviews/${review.id}/submit`, {
        recommendation: 'terminate',
        ratings: { 'Quality of work': 2, Ownership: 1, Collaboration: 2, Learning: 2 },
        comments: 'Did not meet the role’s expectations despite support',
        lastWorkingDate: addDays(today, 30),
      })
      .expect(201);
    expect(await cardFor('hr', personId)).toBeUndefined();
    const card = (await cardFor('hrHead', personId))!;
    expect(card.stepLabel).toBe('HR head decision (termination)');
    await agents.hrHead!.post(`/api/approvals/${card.approvalId}/approve`, {}).expect(201);

    const after = await engagement(personId);
    expect(after).toMatchObject({ status: 'on_notice', last_day: addDays(today, 30) });
    expect(await events(personId)).toContain('probation_terminated');
    expect(await lettersOf(personId)).toEqual([{ type: 'termination', status: 'ready' }]);
  });

  it('a returned decision goes back to the manager, who sends it again', async () => {
    const personId = await onProbation('Ravi Return', addDays(today, 12));
    await sweep(today);
    const review = (await reviewOf(personId))!;
    const body = { recommendation: 'confirm', ratings, comments: 'Good' };
    await agents.mgr!.post(`/api/reviews/${review.id}/submit`, body).expect(201);
    const card = (await cardFor('hr', personId))!;
    await agents
      .hr!.post(`/api/approvals/${card.approvalId}/reject`, { comment: 'Add specific examples' })
      .expect(201);
    expect((await reviewOf(personId))!.status).toBe('due');
    await agents
      .mgr!.post(`/api/reviews/${review.id}/submit`, {
        ...body,
        comments: 'Shipped the export feature',
      })
      .expect(201);
    expect((await cardFor('hr', personId))!.changes).toContainEqual({
      label: 'Manager’s comments',
      from: null,
      to: 'Shipped the export feature',
    });
  });
});

describe('running the sweep now (development and tests only)', () => {
  it('admins can run a scheduled job; others cannot; unknown jobs are not found', async () => {
    const run = await agents.admin!.post('/api/jobs/probation-sweep/run').expect(201);
    expect(run.body).toMatchObject({
      name: 'probation-sweep',
      result: { opened: expect.any(Number) },
    });
    await agents.hr!.post('/api/jobs/probation-sweep/run').expect(403);
    await agents.admin!.post('/api/jobs/no-such-job/run').expect(404);
  });
});

describe('who sees what', () => {
  it('the employee reads their review only after the decision', async () => {
    const review = (await agents.confirmed!.get(`/api/reviews/${confirmedReviewId}`).expect(200))
      .body as ReviewView;
    expect(review).toMatchObject({ status: 'decided', decision: 'confirm', canSubmit: false });
    expect(review.ratings).toEqual(ratings);
  });

  it('H7 dashboard: HR sees overdue, waiting and extended; employees can’t open it', async () => {
    const overdue = await onProbation('Olu Overdue', addDays(today, -2));
    await sweep(today);
    expect((await reviewOf(overdue))!.overdue).toBe(true);
    const board = (await agents.hr!.get('/api/probation/dashboard').expect(200))
      .body as ProbationDashboard;
    expect(board.overdue.map((r) => r.person.name)).toContain('Olu Overdue');
    expect(board.dueSoon.map((d) => d.name)).toContain('Esha Employee');
    expect(board.awaitingDecision.map((r) => r.person.name)).toContain('Ravi Return');
    expect(board.extended.map((e) => e.name)).toContain('Ezhil Extend');
    expect(board.dueSoon.length).toBeGreaterThan(0);
    await agents.emp!.get('/api/probation/dashboard').expect(403);
  });
});
