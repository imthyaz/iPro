import type { INestApplication } from '@nestjs/common';
import type {
  ApprovalCard,
  CheckInView,
  JourneyEntry,
  NotificationView,
  ProbationDashboard,
  ReviewView,
} from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PayConversionsService } from '../src/changes/pay-conversions.service.js';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addMonths } from '../src/reviews/check-ins.service.js';
import { ReviewsService } from '../src/reviews/reviews.service.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only.
const U = {
  hr: '00000000-0000-4000-8000-000000501001',
  hrHead: '00000000-0000-4000-8000-000000501002',
  cxo: '00000000-0000-4000-8000-000000501003',
  mgr: '00000000-0000-4000-8000-000000501004',
};
const email = (id: string) => `${id}@test.ipro.test`;
const today = businessDate(new Date());
const at = (day: string) => new Date(`${day}T06:00:00+05:30`);
const ratings = { 'Quality of work': 4, Ownership: 4, Collaboration: 4, Learning: 5 };

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
let mgrEngagementId: string;
const agents: Record<string, ReturnType<typeof as>> = {};

const sweep = (day: string) =>
  runWithContext({ tenantId: tenant }, () => app.get(ReviewsService).sweep(at(day)));
const reviewOf = async (personId: string) =>
  ((await agents.mgr!.get('/api/reviews').expect(200)).body as ReviewView[]).find(
    (r) => r.person.personId === personId && r.status !== 'decided',
  );
const cardFor = async (who: string, personId: string) =>
  ((await agents[who]!.get('/api/approvals').expect(200)).body as ApprovalCard[]).find(
    (c) => c.subject.personId === personId,
  );
const approve = async (who: string, personId: string) => {
  const card = (await cardFor(who, personId))!;
  await agents[who]!.post(`/api/approvals/${card.approvalId}/approve`, {}).expect(201);
  return card;
};
const engagements = async (personId: string) =>
  (
    await pool.query(
      `select type, status, contract_end_date::text as ends, last_working_date::text as last_day,
              exit_reason, rehire_eligible, employee_code
         from engagement where person_id = $1 order by created_at`,
      [personId],
    )
  ).rows;
const journey = async (personId: string) =>
  (await agents.hr!.get(`/api/people/${personId}/journey`).expect(200)).body as JourneyEntry[];

async function person(name: string, type: string, joiningDate: string) {
  const created = await agents
    .hr!.post('/api/people', {
      person: { legalName: name },
      engagement: { legalEntityId: org.legalEntity, type, joiningDate },
      assignment: {
        designationId: org.softwareEngineer,
        departmentId: org.engineering,
        locationId: org.chennai,
        managerEngagementId: mgrEngagementId,
        bucket: 'trainee',
      },
    })
    .expect(201);
  return created.body.personId as string;
}

/** An intern whose internship ends on `end`, with the assessment open. */
async function internAssessed(name: string, end: string) {
  const personId = await person(name, 'intern', '2026-08-03');
  await pool.query(`update engagement set contract_end_date = $2 where person_id = $1`, [
    personId,
    end,
  ]);
  await sweep(addDays(end, -14));
  return { personId, review: (await reviewOf(personId))! };
}

beforeAll(async () => {
  tenant = await newTenant(pool, 'Intern and check-in tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.hr, 'Ic HR', ['employee', 'hr']);
  await addUser(db, tenant, U.hrHead, 'Ic HR Head', ['employee', 'hr_head']);
  await addUser(db, tenant, U.cxo, 'Ic CXO', ['employee', 'cxo']);
  await addUser(db, tenant, U.mgr, 'Ic Manager', ['employee', 'manager']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  const mgr = await agents
    .hr!.post('/api/people', {
      person: { legalName: 'Mani Manager' },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        workEmail: email(U.mgr),
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
  mgrEngagementId = mgr.body.engagementId;
  await pool.query(`update engagement set confirmation_date = '2024-07-08' where id = $1`, [
    mgrEngagementId,
  ]);
  agents.mgr = as(app, await signIn(app, U.mgr));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('intern assessments (done-when #4, decision #56)', () => {
  it('opens 14 days before the internship ends, reminds at 7, and offers the intern outcomes only', async () => {
    const end = addDays(today, 30);
    const { review } = await internAssessed('Anu Assessed', end);
    expect(review).toMatchObject({
      kind: 'internship',
      dueOn: end,
      reviewer: 'Ic Manager',
      outcomes: ['convert', 'extend', 'end', 'break'],
    });
    await sweep(addDays(end, -7));
    const notes = (await agents.mgr!.get('/api/notifications').expect(200))
      .body as NotificationView[];
    expect(notes.some((n) => n.kind === 'internship_review_reminder')).toBe(true);
    await agents
      .mgr!.post(`/api/reviews/${review.id}/submit`, {
        recommendation: 'confirm',
        ratings,
        comments: 'Good',
      })
      .expect(400);
  });

  it('convert: HR decides, which starts a conversion; HR head and CXO approve; same person, same code', async () => {
    const end = addDays(today, 10);
    const { personId, review } = await internAssessed('Charu Convert', end);
    await agents
      .mgr!.post(`/api/reviews/${review.id}/submit`, {
        recommendation: 'convert',
        ratings,
        comments: 'Strong; ready for a full-time role',
        convertTo: 'permanent',
        convertProbation: 'none',
      })
      .expect(201);
    const decision = await approve('hr', personId);
    expect(decision.changes).toContainEqual({
      label: 'Becomes',
      from: 'intern',
      to: 'permanent, no probation',
    });
    expect((await journey(personId)).map((e) => e.title)).toContain(
      'Internship: converting to employee',
    );
    const conversion = await approve('hrHead', personId);
    expect(conversion.changes).toContainEqual({
      label: 'Engagement',
      from: 'intern',
      to: 'permanent',
    });
    await approve('cxo', personId);
    await runWithContext({ tenantId: tenant }, () =>
      app.get(PayConversionsService).runScheduled(at(addDays(end, 1))),
    );
    const rows = await engagements(personId);
    expect(rows.map((r) => [r.type, r.status, r.exit_reason])).toEqual([
      ['intern', 'exited', 'converted_to_employee'],
      ['permanent', 'active', null],
    ]);
    expect(rows[0].employee_code).toBe(rows[1].employee_code);
  });

  it('extend: the internship end date moves', async () => {
    const end = addDays(today, 12);
    const { personId, review } = await internAssessed('Esha Extend', end);
    await agents
      .mgr!.post(`/api/reviews/${review.id}/submit`, {
        recommendation: 'extend',
        ratings,
        comments: 'Two more months on the data project',
        newEndDate: addDays(end, 60),
      })
      .expect(201);
    expect((await cardFor('hr', personId))!.changes).toContainEqual({
      label: 'Internship ends',
      from: end,
      to: addDays(end, 60),
    });
    await approve('hr', personId);
    expect((await engagements(personId))[0].ends).toBe(addDays(end, 60));
    expect((await journey(personId)).map((e) => e.title)).toContain('Internship extended');
  });

  it('end and break: the internship finishes on the agreed day, rehire eligible', async () => {
    for (const [name, outcome, reason] of [
      ['Ezhil End', 'end', 'internship_completed'],
      ['Bhavna Break', 'break', 'internship_break'],
    ] as const) {
      const end = addDays(today, 8);
      const { personId, review } = await internAssessed(name, end);
      await agents
        .mgr!.post(`/api/reviews/${review.id}/submit`, {
          recommendation: outcome,
          ratings,
          comments: 'Completed the internship',
          lastWorkingDate: end,
          ...(outcome === 'break' ? { returnBy: addDays(end, 120) } : {}),
        })
        .expect(201);
      await approve('hr', personId);
      expect((await engagements(personId))[0]).toMatchObject({
        status: 'on_notice',
        last_day: end,
        exit_reason: reason,
        rehire_eligible: true,
      });
      // Decision #83: the internship ends through the exit workflow, with its checklist.
      expect(await exitCaseOf(personId)).toEqual({
        cases: [{ kind: 'end_of_term', status: 'serving_notice', lwd: end, rehire_eligible: true }],
        exitChecklists: 1,
      });
    }
  });
});

describe('monthly probation check-ins (decision #63)', () => {
  let personId: string;

  it('opens each month’s check-in for the manager; recording it once', async () => {
    personId = await person('Mohan Monthly', 'permanent', addMonths(today, -2));
    const result = await sweep(today);
    expect(result.checkIns.opened).toBeGreaterThanOrEqual(1);
    const open = (await agents.mgr!.get('/api/check-ins?open=true').expect(200))
      .body as CheckInView[];
    const checkIn = open.find((c) => c.person.personId === personId)!;
    expect(checkIn).toMatchObject({ month: 2, dueOn: today, status: 'due', canRecord: true });
    await sweep(today);
    const again = (await agents.mgr!.get('/api/check-ins?open=true').expect(200))
      .body as CheckInView[];
    expect(again.filter((c) => c.person.personId === personId)).toHaveLength(1);

    await agents
      .hr!.post(`/api/check-ins/${checkIn.id}`, { progress: 'on_track', notes: 'x' })
      .expect(403);
    const recorded = (
      await agents
        .mgr!.post(`/api/check-ins/${checkIn.id}`, {
          progress: 'on_track',
          notes: 'Settled in well; owns the release notes',
        })
        .expect(201)
    ).body as CheckInView;
    expect(recorded).toMatchObject({
      status: 'done',
      progress: 'on_track',
      recordedBy: 'Ic Manager',
    });
    await agents
      .mgr!.post(`/api/check-ins/${checkIn.id}`, { progress: 'at_risk', notes: 'Changed mind' })
      .expect(409);
  });

  it('an unrecorded check-in is reminded once after a week and shows as overdue on H7', async () => {
    const late = await person('Lata Late', 'permanent', addMonths(addDays(today, -8), -1));
    await sweep(addDays(today, -8));
    await sweep(today);
    await sweep(today);
    const notes = (await agents.mgr!.get('/api/notifications').expect(200))
      .body as NotificationView[];
    expect(
      notes.filter((n) => n.kind === 'probation_check_in_reminder' && n.title.includes('Lata')),
    ).toHaveLength(1);
    const board = (await agents.hr!.get('/api/probation/dashboard').expect(200))
      .body as ProbationDashboard;
    expect(board.checkInsOverdue.map((c) => c.person.personId)).toContain(late);
  });

  it('the probation decision card shows the check-ins', async () => {
    await pool.query(`update engagement set probation_end_date = $2 where person_id = $1`, [
      personId,
      addDays(today, 20),
    ]);
    await sweep(today);
    const review = (await reviewOf(personId))!;
    expect(review.checkIns.map((c) => [c.month, c.progress])).toEqual([[2, 'on_track']]);
    await agents
      .mgr!.post(`/api/reviews/${review.id}/submit`, {
        recommendation: 'confirm',
        ratings,
        comments: 'Confirm',
      })
      .expect(201);
    expect((await cardFor('hr', personId))!.changes).toContainEqual({
      label: 'Check-ins',
      from: null,
      to: 'Month 2: on track',
    });
  });
});

async function exitCaseOf(personId: string) {
  const cases = await pool.query(
    `select kind, status, last_working_date::text as lwd, rehire_eligible from exit_case
       where person_id = $1`,
    [personId],
  );
  const runs = await pool.query(
    `select count(*)::int as n from checklist_run r join checklist_template t on t.id = r.template_id
       where r.person_id = $1 and t.stage = 'exit'`,
    [personId],
  );
  return { cases: cases.rows, exitChecklists: runs.rows[0].n as number };
}
