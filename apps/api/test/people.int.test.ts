import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import * as schema from '../src/db/schema.js';
import { SEED_ORG, seedOrg } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';
import { TENANT_B } from './test-db.js';

// Synthetic people only. Runs as tenant B, which gets the synthetic seed org.
const HR = '00000000-0000-4000-8000-00000000b001';
const MANAGER = '00000000-0000-4000-8000-00000000b002';
const REPORTEE = '00000000-0000-4000-8000-00000000b003';
const email = (userId: string) => `${userId}@test.ipro.test`;
const SOFTWARE_ENGINEER = '00000000-0000-4000-8000-000000001602';
const TECH_LEAD = '00000000-0000-4000-8000-000000001604';
const MANAGER_DESIGNATION = '00000000-0000-4000-8000-000000001605';

const { pool, db } = testDb();
let app: INestApplication;
let hr: ReturnType<typeof as>;
const today = businessDate(new Date());

const newPerson = (
  legalName: string,
  overrides: {
    workEmail?: string;
    joiningDate?: string;
    designationId?: string;
    manager?: string;
  } = {},
) => ({
  person: {
    legalName,
    personalEmail: `${legalName.toLowerCase().replace(/ /g, '.')}@example.test`,
  },
  engagement: {
    legalEntityId: SEED_ORG.legalEntity,
    type: 'permanent',
    workEmail: overrides.workEmail,
    joiningDate: overrides.joiningDate ?? '2025-06-02',
  },
  assignment: {
    designationId: overrides.designationId ?? SOFTWARE_ENGINEER,
    departmentId: SEED_ORG.engineering,
    locationId: SEED_ORG.chennai,
    managerEngagementId: overrides.manager,
    bucket: 'billable',
  },
});

beforeAll(async () => {
  await withTenant(db, TENANT_B, (tx) => seedOrg(tx, TENANT_B));
  await addUser(db, TENANT_B, HR, 'People HR', ['employee', 'hr']);
  await addUser(db, TENANT_B, MANAGER, 'People Manager', ['employee', 'manager']);
  await addUser(db, TENANT_B, REPORTEE, 'People Reportee', ['employee']);
  app = await createTestApp({ TENANT_ID: TENANT_B });
  hr = as(app, await signIn(app, HR));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('creating a person (done-when #1)', () => {
  let managerPerson: { personId: string; engagementId: string };
  let reporteePerson: { personId: string; engagementId: string };
  let strangerPerson: { personId: string };

  it('creates person, engagement and assignment in one step and writes a Joined event', async () => {
    const response = await hr
      .post('/api/people', {
        ...newPerson('Mira Manager', {
          workEmail: email(MANAGER),
          designationId: MANAGER_DESIGNATION,
        }),
        compensation: { amount: '360000000', rateUnit: 'year' },
      })
      .expect(201);
    managerPerson = response.body;
    expect(response.body).toMatchObject({
      legalName: 'Mira Manager',
      employeeCode: 'IDS-0001',
      status: 'active',
      engagementType: 'permanent',
      designation: { title: 'Engineering Manager' },
      department: { name: 'Engineering' },
      location: { name: 'Chennai office' },
    });

    const events = await withTenant(db, TENANT_B, (tx) =>
      tx
        .select()
        .from(schema.journalEvents)
        .where(sql`${schema.journalEvents.personId} = ${managerPerson.personId}`),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'joined',
      occurredOn: '2025-06-02',
      isPlanned: false,
      sensitivity: 'public',
      sourceTable: 'engagement',
      sourceId: managerPerson.engagementId,
    });
    expect(events[0]!.detailJson).toMatchObject({ employeeCode: 'IDS-0001', viaOfferFlow: false });

    const [engagement] = await withTenant(db, TENANT_B, (tx) =>
      tx
        .select()
        .from(schema.engagements)
        .where(sql`${schema.engagements.id} = ${managerPerson.engagementId}`),
    );
    // Policy defaults: 6 months' probation for permanent staff; Manager+ notice 90 days.
    expect(engagement).toMatchObject({ probationEndDate: '2025-12-01', noticePeriodDays: 90 });
  });

  it('issues the next code, and marks a future joiner pre-joining with a planned event', async () => {
    const joining = addDays(today, 30);
    const response = await hr
      .post(
        '/api/people',
        newPerson('Ravi Reportee', {
          workEmail: email(REPORTEE),
          joiningDate: joining,
          manager: managerPerson.engagementId,
        }),
      )
      .expect(201);
    reporteePerson = response.body;
    expect(response.body).toMatchObject({ employeeCode: 'IDS-0002', status: 'pre_joining' });
    const { rows } = await pool.query(`select is_planned from journal_event where person_id = $1`, [
      reporteePerson.personId,
    ]);
    expect(rows).toEqual([{ is_planned: true }]);

    const stranger = await hr.post('/api/people', newPerson('Sam Stranger')).expect(201);
    strangerPerson = stranger.body;
    expect(stranger.body.employeeCode).toBe('IDS-0003');
  });

  it('refuses a work email already used by a current engagement, and unknown buckets', async () => {
    await hr
      .post('/api/people', newPerson('Dup Licate', { workEmail: email(MANAGER).toUpperCase() }))
      .expect(409);
    const bad = newPerson('Bad Bucket');
    bad.assignment.bucket = 'not-a-bucket';
    await hr.post('/api/people', bad).expect(400);
    // Codes are never reused: failed attempts don't consume one, the next success is IDS-0004.
    const next = await hr.post('/api/people', newPerson('Next Person')).expect(201);
    expect(next.body.employeeCode).toBe('IDS-0004');
  });

  it('links sign-in users to their person by work email; managers see their team only', async () => {
    const manager = as(app, await signIn(app, MANAGER));
    const me = await manager.get('/api/me').expect(200);
    expect(me.body.personId).toBe(managerPerson.personId);

    // The reportee joins in the future, so the reporting line is in force from the joining date.
    const directory = await manager.get(`/api/people?asOf=${addDays(today, 31)}`).expect(200);
    expect(directory.body.map((p: { legalName: string }) => p.legalName).sort()).toEqual([
      'Mira Manager',
      'Ravi Reportee',
    ]);
    await manager.get(`/api/people/${strangerPerson.personId}`).expect(403);
    await manager.get(`/api/people/${reporteePerson.personId}/compensation`).expect(403);
  });

  it('HR sees everyone; compensation reads are decrypted and audited', async () => {
    const directory = await hr.get('/api/people').expect(200);
    expect(directory.body.length).toBeGreaterThanOrEqual(4);
    const comp = await hr.get(`/api/people/${managerPerson.personId}/compensation`).expect(200);
    expect(comp.body).toMatchObject([{ amount: '360000000', rateUnit: 'year', effectiveTo: null }]);
    const { rows } = await pool.query(
      `select action, created_by from audit_log where table_name = 'compensation' and subject_person_id = $1 order by at`,
      [managerPerson.personId],
    );
    expect(rows.map((r) => r.action)).toEqual(['create', 'view']);
    expect(rows[1].created_by).toBe(HR);
    // The stored value is ciphertext.
    const stored = await pool.query(
      `select amount_encrypted from compensation where engagement_id = $1`,
      [managerPerson.engagementId],
    );
    expect(stored.rows[0].amount_encrypted).not.toContain('360000000');
  });

  it('an employee reads their own compensation but changes their profile only by request', async () => {
    const managerAsEmployee = as(app, await signIn(app, MANAGER));
    await managerAsEmployee.get(`/api/people/${managerPerson.personId}/compensation`).expect(200);
    await managerAsEmployee
      .post(`/api/people/${managerPerson.personId}/emergency-contacts`, {
        name: 'Contact Person',
        relation: 'Sibling',
        phone: '+910000000000',
      })
      .expect(409);
    const updated = await hr
      .post(`/api/people/${managerPerson.personId}/emergency-contacts`, {
        name: 'Contact Person',
        relation: 'Sibling',
        phone: '+910000000000',
      })
      .expect(201);
    expect(updated.body.emergencyContacts).toHaveLength(1);
  });

  it('a designation change effective later is planned and keeps history', async () => {
    const effective = addDays(today, 40);
    const history = await hr
      .post(`/api/people/${strangerPerson.personId}/assignments`, {
        effectiveFrom: effective,
        designationId: TECH_LEAD,
        changeReason: 'Promotion',
      })
      .expect(201);
    expect(
      history.body.map(
        (a: {
          effectiveFrom: string;
          effectiveTo: string | null;
          designation: { title: string };
        }) => [a.effectiveFrom, a.effectiveTo, a.designation.title],
      ),
    ).toEqual([
      ['2025-06-02', addDays(effective, -1), 'Software Engineer'],
      [effective, null, 'Tech Lead'],
    ]);
    const { rows } = await pool.query(
      `select event_type, is_planned, occurred_on::text from journal_event where person_id = $1 order by occurred_on`,
      [strangerPerson.personId],
    );
    expect(rows.map((r) => [r.event_type, r.is_planned])).toEqual([
      ['joined', false],
      ['assignment_changed', true],
    ]);
    // Today the person is still a Software Engineer.
    const now = await hr.get(`/api/people/${strangerPerson.personId}`).expect(200);
    expect(now.body.designation.title).toBe('Software Engineer');
  });

  it('the journey is append-only and the assignment history cannot overlap', async () => {
    await expect(
      withTenant(db, TENANT_B, (tx) => tx.update(schema.journalEvents).set({ title: 'rewritten' })),
    ).rejects.toThrow();
    await expect(
      withTenant(db, TENANT_B, (tx) => tx.delete(schema.journalEvents)),
    ).rejects.toThrow();
    await expect(
      withTenant(db, TENANT_B, (tx) =>
        tx.insert(schema.assignments).values({
          tenantId: TENANT_B,
          engagementId: managerPerson.engagementId,
          effectiveFrom: '2025-07-01',
          designationId: SOFTWARE_ENGINEER,
          gradeId: '00000000-0000-4000-8000-000000001502',
          departmentId: SEED_ORG.engineering,
          locationId: SEED_ORG.chennai,
          bucket: 'billable',
          changeReason: 'overlap',
        }),
      ),
    ).rejects.toThrow();
  });
});
