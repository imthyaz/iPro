import type { INestApplication } from '@nestjs/common';
import type { HolidayCalendarView, WorkingDayView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only.
const U = {
  admin: '00000000-0000-4000-8000-000000601001',
  hr: '00000000-0000-4000-8000-000000601002',
};

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
let personId: string;
let company: HolidayCalendarView;
let customer: HolidayCalendarView;
const agents: Record<string, ReturnType<typeof as>> = {};

// 2026-11-09 is a Monday.
const week = { from: '2026-11-08', to: '2026-11-14' };
const days = async () =>
  (
    await agents
      .hr!.get(`/api/people/${personId}/working-days?from=${week.from}&to=${week.to}`)
      .expect(200)
  ).body as WorkingDayView[];
const day = async (date: string) => (await days()).find((d) => d.date === date)!;

beforeAll(async () => {
  tenant = await newTenant(pool, 'Holiday tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Ho Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Ho HR', ['employee', 'hr']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  const created = await agents
    .hr!.post('/api/people', {
      person: { legalName: 'Hema Holiday' },
      engagement: { legalEntityId: org.legalEntity, type: 'permanent', joiningDate: '2024-01-08' },
      assignment: {
        designationId: org.softwareEngineer,
        departmentId: org.engineering,
        locationId: org.chennai,
        bucket: 'billable',
      },
    })
    .expect(201);
  personId = created.body.personId;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('holiday calendars (slice 6a, decisions #48, #66)', () => {
  it('admins keep calendars and holidays; HR reads them', async () => {
    company = (
      await agents
        .admin!.post('/api/holiday-calendars', { code: 'CHN', name: 'Chennai', kind: 'company' })
        .expect(201)
    ).body;
    customer = (
      await agents
        .admin!.post('/api/holiday-calendars', {
          code: 'GULF',
          name: 'Gulf customer',
          kind: 'customer',
        })
        .expect(201)
    ).body;
    await agents
      .hr!.post('/api/holiday-calendars', { code: 'X', name: 'X', kind: 'company' })
      .expect(403);
    await agents
      .admin!.post(`/api/holiday-calendars/${company.id}/holidays`, {
        date: '2026-11-10',
        name: 'Festival day',
        optional: false,
      })
      .expect(201);
    await agents
      .admin!.post(`/api/holiday-calendars/${company.id}/holidays`, {
        date: '2026-11-12',
        name: 'Optional festival',
        optional: true,
      })
      .expect(201);
    await agents
      .admin!.post(`/api/holiday-calendars/${company.id}/holidays`, {
        date: '2026-11-10',
        name: 'Twice',
        optional: false,
      })
      .expect(409);
    await agents
      .admin!.post(`/api/holiday-calendars/${customer.id}/holidays`, {
        date: '2026-11-11',
        name: 'Customer national day',
        optional: false,
      })
      .expect(201);
    const list = (await agents.hr!.get('/api/holiday-calendars?year=2026').expect(200))
      .body as HolidayCalendarView[];
    expect(list.map((c) => [c.code, c.holidays.length])).toEqual([
      ['CHN', 2],
      ['GULF', 1],
    ]);
  });

  it('a location follows its calendar from a date; holidays stop being working days, optional ones don’t', async () => {
    // Before any calendar: an ordinary week.
    expect((await day('2026-11-10')).working).toBe(true);
    await agents
      .admin!.post(`/api/org/units/locations/${org.chennai}/changes`, {
        effectiveFrom: '2026-01-01',
        holidayCalendarId: company.id,
      })
      .expect(201);
    expect(await day('2026-11-10')).toMatchObject({
      working: false,
      holiday: { name: 'Festival day', optional: false },
    });
    expect(await day('2026-11-12')).toMatchObject({
      working: true,
      holiday: { name: 'Optional festival', optional: true },
    });
    expect(await day('2026-11-11')).toMatchObject({ working: true, holiday: null });
    const calendar = (await agents.hr!.get(`/api/holiday-calendars/${company.id}`).expect(200))
      .body as HolidayCalendarView;
    expect(calendar.locations.map((l) => l.id)).toEqual([org.chennai]);
  });

  it('a shift allocation can follow a customer’s calendar instead (decision #48)', async () => {
    await agents
      .hr!.post('/api/shifts/allocations', {
        personIds: [personId],
        shiftId: org.middleEastShift,
        effectiveFrom: '2026-11-01',
        reason: 'Gulf customer project',
        holidayCalendarId: customer.id,
      })
      .expect(201);
    // Sun–Thu, with the customer's holiday, not Chennai's.
    expect((await day('2026-11-08')).working).toBe(true);
    expect((await day('2026-11-10')).working).toBe(true);
    expect(await day('2026-11-11')).toMatchObject({
      working: false,
      holiday: { name: 'Customer national day' },
    });
    expect((await day('2026-11-13')).working).toBe(false);
    const history = (await agents.hr!.get(`/api/people/${personId}/shifts`).expect(200)).body;
    expect(history.at(-1).holidayCalendar).toEqual({ id: customer.id, name: 'Gulf customer' });
  });

  it('removing a holiday is a soft delete', async () => {
    const festival = company.holidays.length
      ? company.holidays[0]
      : (await agents.hr!.get(`/api/holiday-calendars/${company.id}?year=2026`).expect(200)).body
          .holidays[0];
    const id =
      festival?.id ??
      (await pool.query(`select id from holiday where name = 'Festival day'`)).rows[0].id;
    await agents.hr!.delete(`/api/holiday-calendars/${company.id}/holidays/${id}`).expect(403);
    const after = (
      await agents.admin!.delete(`/api/holiday-calendars/${company.id}/holidays/${id}`).expect(200)
    ).body as HolidayCalendarView;
    expect(after.holidays.map((h) => h.name)).toEqual(['Optional festival']);
    const row = await pool.query(
      `select deleted_at is not null as gone from holiday where id = $1`,
      [id],
    );
    expect(row.rows[0].gone).toBe(true);
  });
});
