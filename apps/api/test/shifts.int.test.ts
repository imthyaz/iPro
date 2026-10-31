import type { INestApplication } from '@nestjs/common';
import type { ShiftView, WorkingDayView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import * as schema from '../src/db/schema.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only.
const HR = '00000000-0000-4000-8000-00000000e101';
const ADMIN = '00000000-0000-4000-8000-00000000e102';
const LEAD = '00000000-0000-4000-8000-00000000e103';
const MEMBER = '00000000-0000-4000-8000-00000000e104';
const email = (id: string) => `${id}@test.ipro.test`;

const { pool, db } = testDb();
let app: INestApplication;
let hr: ReturnType<typeof as>;
let org: ReturnType<typeof seedOrgIds>;
let tenant: string;
const people: Record<string, { personId: string; engagementId: string }> = {};

const person = (legalName: string, workEmail?: string, manager?: string) => ({
  person: { legalName },
  engagement: {
    legalEntityId: org.legalEntity,
    type: 'permanent',
    workEmail,
    joiningDate: '2025-01-06',
  },
  assignment: {
    designationId: org.softwareEngineer,
    departmentId: org.engineering,
    locationId: org.chennai,
    managerEngagementId: manager,
    bucket: 'billable',
  },
});

const days = async (viewer: ReturnType<typeof as>, personId: string, from: string, to: string) =>
  (await viewer.get(`/api/people/${personId}/working-days?from=${from}&to=${to}`).expect(200))
    .body as WorkingDayView[];
const workingOn = (list: WorkingDayView[]) => list.filter((d) => d.working).map((d) => d.date);

beforeAll(async () => {
  tenant = await newTenant(pool, 'Shift tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, HR, 'Shift HR', ['employee', 'hr']);
  await addUser(db, tenant, ADMIN, 'Shift Admin', ['admin']);
  await addUser(db, tenant, LEAD, 'Shift Lead', ['employee', 'manager']);
  await addUser(db, tenant, MEMBER, 'Shift Member', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  hr = as(app, await signIn(app, HR));
  people.lead = (await hr.post('/api/people', person('Leela Lead', email(LEAD))).expect(201)).body;
  people.member = (
    await hr
      .post('/api/people', person('Mani Member', email(MEMBER), people.lead!.engagementId))
      .expect(201)
  ).body;
  people.other = (await hr.post('/api/people', person('Oviya Other')).expect(201)).body;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('shifts and working weeks', () => {
  it('Mon–Fri is the default; Sun–Thu is available for Middle East teams', async () => {
    const list = (await hr.get('/api/shifts').expect(200)).body as ShiftView[];
    expect(list.map((s) => [s.code, s.weeklyOffs, s.isDefault])).toEqual([
      ['GEN', [6, 7], true],
      ['ME', [5, 6], false],
    ]);
    // 2026-11-02 is a Monday. Nobody has an allocation yet, so everyone works Mon–Fri.
    expect(workingOn(await days(hr, people.member!.personId, '2026-11-01', '2026-11-07'))).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
    ]);
  });

  it('a project team moves to Sun–Thu for a period, then returns to the default', async () => {
    await hr
      .post('/api/shifts/allocations', {
        personIds: [people.lead!.personId, people.member!.personId],
        shiftId: org.middleEastShift,
        effectiveFrom: '2026-12-01',
        effectiveTo: '2027-02-28',
        // They start and end the day later, to overlap the customer’s hours.
        startTime: '11:00',
        endTime: '20:00',
        reason: 'Gulf customer project (synthetic)',
      })
      .expect(201, { allocated: 2 });

    // Week of Sun 6 Dec 2026: Sun–Thu working, Fri and Sat off.
    const december = await days(hr, people.member!.personId, '2026-12-06', '2026-12-12');
    expect(workingOn(december)).toEqual([
      '2026-12-06',
      '2026-12-07',
      '2026-12-08',
      '2026-12-09',
      '2026-12-10',
    ]);
    expect(
      december.every(
        (d) => d.shiftCode === 'ME' && d.startTime === '11:00' && d.endTime === '20:00',
      ),
    ).toBe(true);

    // After the period: back on Mon–Fri (Fri 5 Mar 2027 is a working day again).
    const march = await days(hr, people.member!.personId, '2027-03-05', '2027-03-07');
    expect(march.map((d) => [d.date, d.working, d.shiftCode, d.startTime, d.endTime])).toEqual([
      ['2027-03-05', true, 'GEN', '09:30', '18:30'],
      ['2027-03-06', false, 'GEN', '09:30', '18:30'],
      ['2027-03-07', false, 'GEN', '09:30', '18:30'],
    ]);
    // Someone not in the team is unaffected.
    expect((await days(hr, people.other!.personId, '2026-12-06', '2026-12-06'))[0]).toMatchObject({
      working: false,
      shiftCode: 'GEN',
    });
  });

  it('a temporary switch inside an open allocation resumes the previous shift afterwards', async () => {
    await hr
      .post('/api/shifts/allocations', {
        personIds: [people.other!.personId],
        shiftId: org.middleEastShift,
        effectiveFrom: '2027-04-01',
        reason: 'Long-term Gulf project (synthetic)',
      })
      .expect(201);
    await hr
      .post('/api/shifts/allocations', {
        personIds: [people.other!.personId],
        shiftId: org.generalShift,
        effectiveFrom: '2027-05-01',
        effectiveTo: '2027-05-31',
        reason: 'Training month in India (synthetic)',
      })
      .expect(201);
    const history = (await hr.get(`/api/people/${people.other!.personId}/shifts`).expect(200)).body;
    expect(
      history.map((h: { shiftName: string; effectiveFrom: string; effectiveTo: string | null }) => [
        h.shiftName,
        h.effectiveFrom,
        h.effectiveTo,
      ]),
    ).toEqual([
      ['Middle East (Sun–Thu)', '2027-04-01', '2027-04-30'],
      ['General (Mon–Fri)', '2027-05-01', '2027-05-31'],
      ['Middle East (Sun–Thu)', '2027-06-01', null],
    ]);
  });

  it('refuses a start time without an end time', async () => {
    await hr
      .post('/api/shifts/allocations', {
        personIds: [people.lead!.personId],
        shiftId: org.middleEastShift,
        effectiveFrom: '2027-08-01',
        startTime: '10:00',
        reason: 'half a time',
      })
      .expect(400);
  });

  it('refuses a change that would cut across one already planned', async () => {
    await hr
      .post('/api/shifts/allocations', {
        personIds: [people.other!.personId],
        shiftId: org.generalShift,
        effectiveFrom: '2027-04-15',
        effectiveTo: '2027-05-15',
        reason: 'Overlapping (synthetic)',
      })
      .expect(409);
    // The database refuses overlapping allocations too.
    await expect(
      withTenant(db, tenant, (tx) =>
        tx.insert(schema.shiftAssignments).values({
          tenantId: tenant,
          engagementId: people.other!.engagementId,
          shiftId: org.generalShift,
          effectiveFrom: '2027-04-10',
          reason: 'overlap',
        }),
      ),
    ).rejects.toThrow();
  });

  it('follows the permissions table', async () => {
    const lead = as(app, await signIn(app, LEAD));
    await lead
      .post('/api/shifts/allocations', {
        personIds: [people.member!.personId],
        shiftId: org.generalShift,
        effectiveFrom: '2027-06-01',
        reason: 'not allowed',
      })
      .expect(403);
    // Managers and employees see working days for their team and themselves.
    await lead
      .get(`/api/people/${people.member!.personId}/working-days?from=2026-12-06&to=2026-12-06`)
      .expect(200);
    await lead
      .get(`/api/people/${people.other!.personId}/working-days?from=2026-12-06&to=2026-12-06`)
      .expect(403);
    const member = as(app, await signIn(app, MEMBER));
    await member
      .get(`/api/people/${people.member!.personId}/working-days?from=2026-12-06&to=2026-12-06`)
      .expect(200);
    await member
      .post('/api/shifts', {
        code: 'X',
        name: 'X',
        startTime: '09:00',
        endTime: '17:00',
        weeklyOffs: [7],
      })
      .expect(403);
  });

  it('admin adds a shift and can move the default', async () => {
    const admin = as(app, await signIn(app, ADMIN));
    const night = await admin
      .post('/api/shifts', {
        code: 'NIGHT',
        name: 'US support (night)',
        startTime: '21:00',
        endTime: '06:00',
        weeklyOffs: [6, 7],
      })
      .expect(201);
    expect(night.body).toMatchObject({ breakMinutes: 60, graceMinutes: 15, isDefault: false });
    await admin
      .post('/api/shifts', {
        code: 'BAD',
        name: 'Bad',
        startTime: '09:00',
        endTime: '17:00',
        weeklyOffs: [1, 1],
      })
      .expect(400);
    await admin.patch(`/api/shifts/${org.generalShift}`, { isDefault: false }).expect(400);
    await admin.patch(`/api/shifts/${night.body.id}`, { isDefault: true }).expect(200);
    const list = (await admin.get('/api/shifts').expect(200)).body as ShiftView[];
    expect(list.filter((s) => s.isDefault).map((s) => s.code)).toEqual(['NIGHT']);
  });
});
