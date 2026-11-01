import type { INestApplication } from '@nestjs/common';
import type { ApprovalCard, JourneyEntry } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only.
const U = {
  admin: '00000000-0000-4000-8000-000000301001',
  hr: '00000000-0000-4000-8000-000000301002',
  hrHead: '00000000-0000-4000-8000-000000301003',
  emp: '00000000-0000-4000-8000-000000301004',
};
const email = (id: string) => `${id}@test.ipro.test`;
const today = businessDate(new Date());

/** The first day of next month, in India. */
const nextMonth = (() => {
  const [y, m] = today.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
})();

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
let personId: string;
const agents: Record<string, ReturnType<typeof as>> = {};

const cardFor = async (who: string) =>
  ((await agents[who]!.get('/api/approvals').expect(200)).body as ApprovalCard[]).find(
    (c) => c.subject.personId === personId,
  );
/** The person's designation as the directory shows it on a day (the role in force then). */
const designationOn = async (day: string) => {
  const people = (await agents.hr!.get(`/api/people?q=Deepa&asOf=${day}`).expect(200)).body as {
    personId: string;
    designation: { title: string } | null;
  }[];
  return people.find((p) => p.personId === personId)?.designation?.title;
};

beforeAll(async () => {
  tenant = await newTenant(pool, 'Change tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Ch Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Ch HR', ['employee', 'hr']);
  await addUser(db, tenant, U.hrHead, 'Ch HR Head', ['employee', 'hr_head']);
  await addUser(db, tenant, U.emp, 'Ch Employee', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  const created = await agents
    .hr!.post('/api/people', {
      person: { legalName: 'Deepa Developer' },
      engagement: {
        legalEntityId: org.legalEntity,
        type: 'permanent',
        workEmail: email(U.emp),
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
  personId = created.body.personId;
  agents.emp = as(app, await signIn(app, U.emp));
  await agents
    .admin!.put('/api/letter-templates/promotion', {
      name: 'Promotion letter',
      type: 'other',
      body: 'Dear {{person.legalName}}, from {{extra.from}} you are {{assignment.designation}}.',
      approverRole: null,
      signature: 'none',
    })
    .expect(200);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('in-life changes (spec workflow 8; done-when #3)', () => {
  const seniorEngineer = () => org.id(1603);

  it('HR asks; a bad change is refused at once, not at approval', async () => {
    await agents
      .hr!.post(`/api/people/${personId}/changes`, {
        effectiveFrom: '2023-01-01',
        reason: 'Before joining',
        designationId: seniorEngineer(),
      })
      .expect(400);
    await agents
      .hr!.post(`/api/people/${personId}/changes`, { effectiveFrom: nextMonth, reason: 'Nothing' })
      .expect(400);
    await agents
      .emp!.post(`/api/people/${personId}/changes`, {
        effectiveFrom: nextMonth,
        reason: 'Promotion',
        designationId: seniorEngineer(),
      })
      .expect(403);
  });

  it('a designation change effective next month shows as upcoming, and applies by itself that day', async () => {
    const { requestId } = (
      await agents
        .hr!.post(`/api/people/${personId}/changes`, {
          effectiveFrom: nextMonth,
          reason: 'Promotion',
          designationId: seniorEngineer(),
          letterTemplateKey: 'promotion',
          extra: { from: nextMonth },
        })
        .expect(201)
    ).body as { requestId: string };
    expect(requestId).toBeTruthy();
    expect(await cardFor('hr')).toBeUndefined();
    const card = (await cardFor('hrHead'))!;
    expect(card.stepLabel).toBe('HR head approval');
    expect(card.changes).toEqual(
      expect.arrayContaining([
        { label: 'Designation', from: 'Software Engineer', to: 'Senior Software Engineer' },
        { label: 'From', from: null, to: nextMonth },
      ]),
    );
    // Nothing changes before approval.
    expect(await designationOn(nextMonth)).toBe('Software Engineer');

    await agents.hrHead!.post(`/api/approvals/${card.approvalId}/approve`, {}).expect(201);

    expect(await designationOn(today)).toBe('Software Engineer');
    expect(await designationOn(nextMonth)).toBe('Senior Software Engineer');
    const journey = (await agents.emp!.get(`/api/people/${personId}/journey`).expect(200))
      .body as JourneyEntry[];
    expect(journey.find((e) => e.title === 'Promotion')).toMatchObject({
      occurredOn: nextMonth,
      isPlanned: true,
      upcoming: true,
    });
    // The letter reads the role as of the change date.
    const { rows } = await pool.query(
      `select l.status from letter l join letter_template t on t.id = l.template_id
        where l.person_id = $1 and t.key = 'promotion'`,
      [personId],
    );
    expect(rows).toEqual([{ status: 'ready' }]);
  });

  it('once the date has passed the event is no longer upcoming', async () => {
    await pool.query(
      `update journal_event set occurred_on = $2 where person_id = $1 and title = 'Promotion'`,
      [personId, addDays(today, -1)],
    );
    const journey = (await agents.hr!.get(`/api/people/${personId}/journey`).expect(200))
      .body as JourneyEntry[];
    expect(journey.find((e) => e.title === 'Promotion')).toMatchObject({ upcoming: false });
  });

  it('HR head’s own change applies at once: they are the approver', async () => {
    const result = (
      await agents
        .hrHead!.post(`/api/people/${personId}/changes`, {
          effectiveFrom: addDays(nextMonth, 10),
          reason: 'Moved to Bangalore project',
          bucket: 'bench',
        })
        .expect(201)
    ).body;
    expect(result).toEqual({ applied: true });
    expect(await cardFor('hrHead')).toBeUndefined();
    const people = (
      await agents.hr!.get(`/api/people?q=Deepa&asOf=${addDays(nextMonth, 10)}`).expect(200)
    ).body as { bucket: string }[];
    expect(people[0]!.bucket).toBe('bench');
  });

  it('direct changes are for HR head only (approval included); HR uses the request', async () => {
    const direct = {
      effectiveFrom: addDays(nextMonth, 31),
      changeReason: 'Moved to QA',
      departmentId: org.quality,
    };
    await agents.hr!.post(`/api/people/${personId}/assignments`, direct).expect(403);
    await agents.hrHead!.post(`/api/people/${personId}/assignments`, direct).expect(201);
  });
});
