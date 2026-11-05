import type { INestApplication } from '@nestjs/common';
import type { AttendanceDayView, TodayView } from '@ipro/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttendanceService } from '../src/attendance/attendance.service.js';
import { businessDate } from '../src/common/effective-dating.js';
import { runWithContext } from '../src/context/request-context.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only. The office is placed at a made-up point; check-ins are offsets from it.
const U = {
  admin: '00000000-0000-4000-8000-000000602001',
  hr: '00000000-0000-4000-8000-000000602002',
  emp: '00000000-0000-4000-8000-000000602003',
  other: '00000000-0000-4000-8000-000000602004',
};
const email = (id: string) => `${id}@test.ipro.test`;
const OFFICE = { latitude: 12.5, longitude: 79.5 };
// About 0.0009° of latitude is 100 m.
const near = { latitude: OFFICE.latitude + 0.0009, longitude: OFFICE.longitude };
const far = { latitude: OFFICE.latitude + 0.02, longitude: OFFICE.longitude };

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
let emp: { personId: string; employeeCode: string };
let deviceKey: string;
let deviceId: string;
const agents: Record<string, ReturnType<typeof as>> = {};

const push = (body: object, key = deviceKey) =>
  request(app.getHttpServer()).post('/api/biometric/punches').set('x-device-key', key).send(body);
const month = async (m: string, who = agents.hr!) =>
  (await who.get(`/api/people/${emp.personId}/attendance?month=${m}`).expect(200))
    .body as AttendanceDayView[];
const on = (days: AttendanceDayView[], date: string) => days.find((d) => d.date === date)!;

async function hire(name: string, userId: string) {
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
      },
    })
    .expect(201);
  return res.body as { personId: string; employeeCode: string };
}

beforeAll(async () => {
  tenant = await newTenant(pool, 'Attendance tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'At Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'At HR', ['employee', 'hr']);
  await addUser(db, tenant, U.emp, 'At Employee', ['employee']);
  await addUser(db, tenant, U.other, 'At Other', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  emp = await hire('Esha Employee', U.emp);
  await hire('Omar Other', U.other);
  // The office's coordinates and a 150 m geofence, plus a holiday on Wed 4 Nov.
  const calendar = (
    await agents
      .admin!.post('/api/holiday-calendars', { code: 'CHN', name: 'Chennai', kind: 'company' })
      .expect(201)
  ).body;
  await agents
    .admin!.post(`/api/holiday-calendars/${calendar.id}/holidays`, {
      date: '2026-11-04',
      name: 'Festival day',
      optional: false,
    })
    .expect(201);
  await agents
    .admin!.post(`/api/org/units/locations/${org.chennai}/changes`, {
      effectiveFrom: '2026-01-01',
      holidayCalendarId: calendar.id,
      ...OFFICE,
      geofenceRadiusMetres: 150,
    })
    .expect(201);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('biometric devices and the push (decision #67; done-when #1)', () => {
  it('admins register a device and see its key once; others may not', async () => {
    await agents
      .hr!.post('/api/biometric/devices', { code: 'CHN-1', name: 'Lobby', locationId: org.chennai })
      .expect(403);
    const res = await agents
      .admin!.post('/api/biometric/devices', {
        code: 'CHN-1',
        name: 'Lobby',
        locationId: org.chennai,
      })
      .expect(201);
    deviceKey = res.body.key;
    deviceId = res.body.id;
    expect(deviceKey.length).toBeGreaterThan(30);
    const list = (await agents.admin!.get('/api/biometric/devices').expect(200)).body;
    expect(list).toEqual([
      expect.objectContaining({ code: 'CHN-1', location: 'Chennai office', lastSeenAt: null }),
    ]);
    expect(JSON.stringify(list)).not.toContain(deviceKey);
    const stored = await pool.query(`select key_hash from biometric_device where id = $1`, [
      deviceId,
    ]);
    expect(stored.rows[0].key_hash).not.toBe(deviceKey);
  });

  it('a push without a valid key is refused', async () => {
    const body = {
      punches: [
        { employeeCode: emp.employeeCode, at: '2026-11-02T09:20:00+05:30', externalId: 'x' },
      ],
    };
    await request(app.getHttpServer()).post('/api/biometric/punches').send(body).expect(401);
    await push(body, 'not-a-key').expect(401);
  });

  it('pushed punches show on the attendance calendar at once; resends are not counted twice', async () => {
    const body = {
      punches: [
        { employeeCode: emp.employeeCode, at: '2026-11-02T09:20:00+05:30', externalId: 'p1' },
        { employeeCode: emp.employeeCode, at: '2026-11-02T18:35:00+05:30', externalId: 'p2' },
        { employeeCode: 'IDS-9999', at: '2026-11-02T09:00:00+05:30', externalId: 'p3' },
      ],
    };
    expect((await push(body).expect(200)).body).toEqual({
      accepted: 2,
      duplicates: 0,
      unknownEmployeeCodes: ['IDS-9999'],
    });
    expect((await push(body).expect(200)).body).toMatchObject({ accepted: 0, duplicates: 2 });
    const monday = on(await month('2026-11'), '2026-11-02');
    expect(monday).toMatchObject({
      status: 'present',
      firstIn: '2026-11-02T03:50:00.000Z',
      lastOut: '2026-11-02T13:05:00.000Z',
      workedMinutes: 9 * 60 + 15 - 60,
      flags: [],
    });
    const device = (await agents.admin!.get('/api/biometric/devices').expect(200)).body[0];
    expect(device.lastSeenAt).not.toBeNull();
  });

  it('a revoked device can no longer push', async () => {
    const extra = await agents
      .admin!.post('/api/biometric/devices', {
        code: 'CHN-2',
        name: 'Gate',
        locationId: org.chennai,
      })
      .expect(201);
    await agents.admin!.delete(`/api/biometric/devices/${extra.body.id}`).expect(204);
    await push(
      {
        punches: [
          { employeeCode: emp.employeeCode, at: '2026-11-02T10:00:00+05:30', externalId: 'g1' },
        ],
      },
      extra.body.key,
    ).expect(401);
  });
});

describe('the attendance calendar (done-when #3)', () => {
  it('holidays and weekly offs show; a working day with no punch becomes absent in the nightly build', async () => {
    let days = await month('2026-11');
    expect(days).toHaveLength(30);
    expect(on(days, '2026-11-01')).toMatchObject({ status: 'weekly_off', working: false });
    expect(on(days, '2026-11-04')).toMatchObject({ status: 'holiday', holiday: 'Festival day' });
    expect(on(days, '2026-11-03').status).toBeNull();
    const built = await runWithContext({ tenantId: tenant }, () =>
      app.get(AttendanceService).buildDay('2026-11-03', new Date('2026-11-04T02:00:00+05:30')),
    );
    expect(built.built).toBeGreaterThanOrEqual(2);
    days = await month('2026-11');
    expect(on(days, '2026-11-03').status).toBe('absent');
    expect(on(days, '2026-11-02').status).toBe('present');
  });

  it('people see their own attendance, not a colleague’s', async () => {
    await month('2026-11', agents.emp!);
    await agents.other!.get(`/api/people/${emp.personId}/attendance?month=2026-11`).expect(403);
    await agents.hr!.get(`/api/people/${emp.personId}/attendance?month=2026-13`).expect(400);
  });
});

describe('check-in from web and phone (decision #68; done-when #2)', () => {
  it('records the mode and location, and flags a check-in outside the geofence', async () => {
    const before = (await agents.emp!.get('/api/attendance/today').expect(200)).body as TodayView;
    expect(before).toMatchObject({ checkedIn: false, punches: [], lastMode: null });

    const checkedIn = (
      await agents
        .emp!.post('/api/attendance/check-in', { mode: 'office', device: 'mobile', ...far })
        .expect(201)
    ).body as TodayView;
    expect(checkedIn.checkedIn).toBe(true);
    expect(checkedIn.punches[0]).toMatchObject({
      source: 'mobile',
      mode: 'office',
      direction: 'in',
      outsideGeofence: true,
    });
    expect(checkedIn.punches[0]!.distanceMetres).toBeGreaterThan(2000);

    const out = (
      await agents
        .emp!.post('/api/attendance/check-out', {
          mode: 'office',
          device: 'mobile',
          ...near,
          accuracy: 20,
        })
        .expect(201)
    ).body as TodayView;
    expect(out.checkedIn).toBe(false);
    expect(out.punches[1]).toMatchObject({ direction: 'out', outsideGeofence: false });
    expect(out.lastMode).toBe('office');

    const today = businessDate(new Date());
    const row = on(await month(today.slice(0, 7)), today);
    expect(row.flags).toContain('outside_geofence');
    expect(row.mode).toBe('office');
    const stored = await pool.query(
      `select latitude, longitude, site_location_id from punch where person_id = $1 and source = 'mobile' order by at`,
      [emp.personId],
    );
    expect(stored.rows[0]).toMatchObject({ ...far, site_location_id: org.chennai });
  });

  it('a poor fix is given its accuracy; WFH has no geofence; no location is flagged', async () => {
    // About 245 m out with 120 m accuracy counts as 145 m away (accuracy is capped at 100 m): inside 150 m.
    const edge = { latitude: OFFICE.latitude + 0.0022, longitude: OFFICE.longitude };
    const first = (
      await agents
        .other!.post('/api/attendance/check-in', {
          mode: 'office',
          device: 'mobile',
          ...edge,
          accuracy: 120,
        })
        .expect(201)
    ).body as TodayView;
    expect(first.punches[0]!.outsideGeofence).toBe(false);

    const wfh = (
      await agents
        .other!.post('/api/attendance/check-out', { mode: 'wfh', device: 'web', ...far })
        .expect(201)
    ).body as TodayView;
    expect(wfh.punches[1]).toMatchObject({ mode: 'wfh', outsideGeofence: null });

    const blind = (
      await agents
        .other!.post('/api/attendance/check-in', { mode: 'office', device: 'web' })
        .expect(201)
    ).body as TodayView;
    expect(blind.punches[2]).toMatchObject({ outsideGeofence: null, distanceMetres: null });
    const me = (await agents.other!.get('/api/me').expect(200)).body;
    const today = businessDate(new Date());
    const days = (
      await agents
        .other!.get(`/api/people/${me.personId}/attendance?month=${today.slice(0, 7)}`)
        .expect(200)
    ).body as AttendanceDayView[];
    expect(on(days, today).flags).toContain('no_location');
  });

  it('refuses bad input and people without a person record', async () => {
    await agents
      .emp!.post('/api/attendance/check-in', { mode: 'beach', device: 'web' })
      .expect(400);
    await agents
      .admin!.post('/api/attendance/check-in', { mode: 'office', device: 'web' })
      .expect(403);
  });
});
