import type { INestApplication } from '@nestjs/common';
import type { ApprovalCard, JourneyEntry } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { PayConversionsService } from '../src/changes/pay-conversions.service.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only.
const U = {
  hr: '00000000-0000-4000-8000-000000401001',
  hrHead: '00000000-0000-4000-8000-000000401002',
  cxo: '00000000-0000-4000-8000-000000401003',
  intern: '00000000-0000-4000-8000-000000401004',
};
const email = (id: string) => `${id}@test.ipro.test`;
const today = businessDate(new Date());

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const agents: Record<string, ReturnType<typeof as>> = {};

const cardFor = async (who: string, personId: string) =>
  ((await agents[who]!.get('/api/approvals').expect(200)).body as ApprovalCard[]).find(
    (c) => c.subject.personId === personId,
  );
const approve = async (who: string, personId: string) => {
  const card = (await cardFor(who, personId))!;
  await agents[who]!.post(`/api/approvals/${card.approvalId}/approve`, {}).expect(201);
  return card;
};
const journey = async (personId: string) =>
  (await agents.hr!.get(`/api/people/${personId}/journey`).expect(200)).body as JourneyEntry[];

async function person(name: string, type: string, workEmail?: string, pay?: object) {
  const created = await agents
    .hr!.post('/api/people', {
      person: { legalName: name },
      engagement: {
        legalEntityId: org.legalEntity,
        type,
        joiningDate: '2026-06-01',
        ...(workEmail ? { workEmail } : {}),
      },
      assignment: {
        designationId: org.softwareEngineer,
        departmentId: org.engineering,
        locationId: org.chennai,
        bucket: 'trainee',
      },
      ...(pay ? { compensation: pay } : {}),
    })
    .expect(201);
  return created.body.personId as string;
}

beforeAll(async () => {
  tenant = await newTenant(pool, 'Pay and conversion tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.hr, 'Pc HR', ['employee', 'hr']);
  await addUser(db, tenant, U.hrHead, 'Pc HR Head', ['employee', 'hr_head']);
  await addUser(db, tenant, U.cxo, 'Pc CXO', ['employee', 'cxo']);
  await addUser(db, tenant, U.intern, 'Pc Intern', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('pay changes (done-when #5)', () => {
  let internId: string;

  it('an unpaid intern becomes paid from a date, with HR head’s approval and a journey event', async () => {
    internId = await person('Isha Intern', 'intern', email(U.intern));
    agents.intern = as(app, await signIn(app, U.intern));
    const from = addDays(today, 10);
    await agents
      .intern!.post(`/api/people/${internId}/pay-changes`, {
        effectiveFrom: from,
        reason: 'Stipend',
        amount: '1500000',
        rateUnit: 'month',
      })
      .expect(403);
    const { requestId } = (
      await agents
        .hr!.post(`/api/people/${internId}/pay-changes`, {
          effectiveFrom: from,
          reason: 'Stipend from next cohort',
          amount: '1500000',
          rateUnit: 'month',
        })
        .expect(201)
    ).body;
    expect(requestId).toBeTruthy();

    // The amount never sits in the request as plain text.
    const stored = await pool.query(
      `select payload::text as p from workflow_instance where id = $1`,
      [requestId],
    );
    expect(stored.rows[0].p).not.toContain('1500000');

    const card = await approve('hrHead', internId);
    expect(card.changes).toEqual(
      expect.arrayContaining([
        { label: 'Pay', from: 'Unpaid', to: '₹15,000 a month' },
        { label: 'From', from: null, to: from },
      ]),
    );
    const pay = (await agents.hr!.get(`/api/people/${internId}/compensation`).expect(200)).body;
    expect(pay).toEqual([expect.objectContaining({ effectiveFrom: from, rateUnit: 'month' })]);
    expect(await journey(internId)).toContainEqual(
      expect.objectContaining({ title: 'Became paid', occurredOn: from, upcoming: true }),
    );
    const audits = await pool.query(
      `select count(*)::int as n from audit_log where table_name = 'change_request' and action = 'view'
         and subject_person_id = $1`,
      [internId],
    );
    expect(audits.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('a later raise reads as from → to; direct pay changes are HR head’s only', async () => {
    await agents
      .hr!.post(`/api/people/${internId}/pay-changes`, {
        effectiveFrom: addDays(today, 40),
        reason: 'Mid-internship raise',
        amount: '2000000',
        rateUnit: 'month',
      })
      .expect(201);
    const card = (await cardFor('hrHead', internId))!;
    expect(card.changes).toContainEqual({
      label: 'Pay',
      from: '₹15,000 a month',
      to: '₹20,000 a month',
    });
    await agents
      .hr!.post(`/api/people/${internId}/compensation`, {
        effectiveFrom: addDays(today, 60),
        amount: '2500000',
        rateUnit: 'month',
      })
      .expect(403);
  });
});

describe('conversions (decisions #42, #64)', () => {
  it('a retainer converting next month: HR head, then CXO; scheduled, shown as upcoming, applied on the day', async () => {
    const retainerId = await person('Ravi Retainer', 'retainer', undefined, {
      amount: '15000000',
      rateUnit: 'month',
    });
    const from = addDays(today, 20);
    await agents
      .hr!.post(`/api/people/${retainerId}/conversion-requests`, {
        effectiveFrom: from,
        type: 'permanent',
        probation: 'none',
        reason: 'Joining payroll',
        compensation: { amount: '180000000', rateUnit: 'year' },
      })
      .expect(201);
    expect(await cardFor('cxo', retainerId)).toBeUndefined();
    const first = await approve('hrHead', retainerId);
    expect(first.changes).toEqual(
      expect.arrayContaining([
        { label: 'Engagement', from: 'retainer', to: 'permanent' },
        { label: 'Probation', from: null, to: 'No probation' },
        { label: 'Pay', from: '₹1,50,000 a month', to: '₹18,00,000 a year' },
      ]),
    );
    await approve('cxo', retainerId);

    // Approved ahead of its date: scheduled, and upcoming on the journey.
    expect(await journey(retainerId)).toContainEqual(
      expect.objectContaining({ title: 'Converts to permanent', upcoming: true }),
    );
    const before = await pool.query(
      `select type, status from engagement where person_id = $1 order by created_at`,
      [retainerId],
    );
    expect(before.rows).toEqual([{ type: 'retainer', status: 'active' }]);

    const service = app.get(PayConversionsService);
    expect(
      await runWithContext({ tenantId: tenant }, () =>
        service.runScheduled(new Date(`${addDays(from, -1)}T05:30:00+05:30`)),
      ),
    ).toEqual({ applied: 0, failed: 0 });
    expect(
      await runWithContext({ tenantId: tenant }, () =>
        service.runScheduled(new Date(`${from}T05:30:00+05:30`)),
      ),
    ).toEqual({ applied: 1, failed: 0 });

    const after = await pool.query(
      `select type, status, exit_reason from engagement where person_id = $1 order by created_at`,
      [retainerId],
    );
    expect(after.rows).toEqual([
      { type: 'retainer', status: 'exited', exit_reason: 'converted_to_payroll' },
      { type: 'permanent', status: 'active', exit_reason: null },
    ]);
    const events = (await journey(retainerId)).map((e) => e.title);
    expect(events).toContain('Converted from retainer to permanent');
  });

  it('an intern converts to employee today: applied on approval, with probation by policy', async () => {
    const internId = await person('Kiran Intern', 'intern');
    await agents
      .hr!.post(`/api/people/${internId}/conversion-requests`, {
        effectiveFrom: today,
        type: 'permanent',
        probation: 'policy',
        reason: 'Strong internship',
        compensation: { amount: '90000000', rateUnit: 'year' },
      })
      .expect(201);
    await approve('hrHead', internId);
    await approve('cxo', internId);
    const rows = await pool.query(
      `select type, status, exit_reason, probation_end_date is not null as on_probation
         from engagement where person_id = $1 order by created_at`,
      [internId],
    );
    expect(rows.rows).toEqual([
      {
        type: 'intern',
        status: 'exited',
        exit_reason: 'converted_to_employee',
        on_probation: false,
      },
      { type: 'permanent', status: 'active', exit_reason: null, on_probation: true },
    ]);
  });

  it('refuses a conversion that can’t apply, at once', async () => {
    const permanentId = await person('Prema Permanent', 'permanent');
    await agents
      .hr!.post(`/api/people/${permanentId}/conversion-requests`, {
        effectiveFrom: addDays(today, 5),
        type: 'permanent',
        probation: 'none',
        reason: 'Already permanent',
      })
      .expect(400);
  });
});
