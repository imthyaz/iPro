import type { INestApplication } from '@nestjs/common';
import type { ImportResult, LeaveImportResult, PersonTimelineView } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only, loaded as a migration would load them.
const U = {
  admin: '00000000-0000-4000-8000-000000705001',
  hr: '00000000-0000-4000-8000-000000705002',
  mgr: '00000000-0000-4000-8000-000000705003',
};
const today = businessDate(new Date());

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
const agents: Record<string, ReturnType<typeof as>> = {};
const personOf: Record<string, string> = {};

const PEOPLE = [
  'employee_code,legal_name,work_email,engagement_type,joining_date,status,last_working_date,exit_reason,designation,department,location,manager_code,bucket',
  'IDS-0100,Anbu Lead,anbu@old.test,permanent,2023-04-10,active,,,Software Engineer,Engineering,Chennai office,,billable',
  'IDS-0101,Bala Left,bala@old.test,permanent,2023-05-01,exited,2025-09-30,resigned,Software Engineer,Engineering,Chennai office,IDS-0100,billable',
  'IDS-0102,Chitra Report,chitra@old.test,permanent,2024-06-01,active,,,Software Engineer,Engineering,Chennai office,IDS-0100,billable',
].join('\n');
const HISTORY = [
  'employee_code,date,event,detail',
  'IDS-0100,2023-10-10,confirmed,',
  'IDS-0100,2024-04-01,designation_changed,Senior Software Engineer',
  'IDS-0102,2025-01-01,team_changed,Quality Engineering',
  'IDS-0101,2025-09-30,exited,Moved abroad',
].join('\n');

const history = async (csv: string, commit: boolean, recordedFrom = '2024-01-01') =>
  (await agents.hr!.post('/api/imports/history', { csv, commit, recordedFrom }).expect(200))
    .body as ImportResult;
const migrated = async () =>
  (
    await pool.query(
      `select count(*)::int as n from journal_event where tenant_id = $1 and source_table = 'migration'`,
      [tenant],
    )
  ).rows[0].n as number;

beforeAll(async () => {
  tenant = await newTenant(pool, 'Migration history tests');
  const org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  void org;
  await addUser(db, tenant, U.admin, 'Mh Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Mh HR', ['employee', 'hr']);
  await addUser(db, tenant, U.mgr, 'Mh Manager', ['employee', 'manager']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
  const loaded = (
    await agents.hr!.post('/api/imports/people', { csv: PEOPLE, commit: true }).expect(200)
  ).body as ImportResult;
  expect(loaded.errors).toEqual([]);
  const { rows } = await pool.query(
    `select employee_code, person_id from engagement where tenant_id = $1`,
    [tenant],
  );
  for (const r of rows) personOf[r.employee_code] = r.person_id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('history back-fill (slice 13 done-when #3; decision #95)', () => {
  it('a check adds nothing', async () => {
    expect(await history(HISTORY, false)).toEqual({
      committed: false,
      rows: 4,
      ready: 4,
      errors: [],
    });
    expect(await migrated()).toBe(0);
  });

  it('a bad file loads nothing', async () => {
    const r = await history(
      [HISTORY, 'IDS-0102,2020-01-01,confirmed,', 'IDS-0102,2025-02-01,exited,'].join('\n'),
      true,
    );
    expect(r.committed).toBe(false);
    expect(r.errors).toEqual([
      { line: 6, message: 'date 2020-01-01 is before joining on 2024-06-01' },
      { line: 7, message: "IDS-0102 hasn't left in iPro" },
    ]);
    expect(await migrated()).toBe(0);
  });

  it('loads past events as journey events marked migrated', async () => {
    expect(await history(HISTORY, true)).toEqual({
      committed: true,
      rows: 4,
      ready: 4,
      errors: [],
    });
    const { rows } = await pool.query(
      `select event_type, category, occurred_on::text as date, title, sensitivity, migrated
         from journal_event where tenant_id = $1 and source_table = 'migration' order by occurred_on`,
      [tenant],
    );
    expect(rows).toEqual([
      {
        event_type: 'probation_confirmed',
        category: 'lifecycle',
        date: '2023-10-10',
        title: 'Confirmed',
        sensitivity: 'public',
        migrated: true,
      },
      {
        event_type: 'designation_changed',
        category: 'career',
        date: '2024-04-01',
        title: 'Became Senior Software Engineer',
        sensitivity: 'public',
        migrated: true,
      },
      {
        event_type: 'team_changed',
        category: 'team',
        date: '2025-01-01',
        title: 'Moved to Quality Engineering',
        sensitivity: 'public',
        migrated: true,
      },
      {
        event_type: 'exited',
        category: 'lifecycle',
        date: '2025-09-30',
        title: 'Left',
        sensitivity: 'hr',
        migrated: true,
      },
    ]);
  });

  it('the journey shows the events, and marks history before the recorded date', async () => {
    const anbu = (await agents.hr!.get(`/api/people/${personOf['IDS-0100']}/timeline`).expect(200))
      .body as PersonTimelineView;
    expect(anbu.historyFrom).toBe('2024-01-01');
    const titles = anbu.events.map((e) => [e.title, e.category]);
    expect(titles).toEqual(
      expect.arrayContaining([
        ['Confirmed', 'lifecycle'],
        ['Became Senior Software Engineer', 'career'],
      ]),
    );
    // Chitra joined after the history is complete: no marker.
    const chitra = (
      await agents.hr!.get(`/api/people/${personOf['IDS-0102']}/timeline`).expect(200)
    ).body as PersonTimelineView;
    expect(chitra.historyFrom).toBeNull();
  });

  it('loading the same history again adds nothing', async () => {
    const r = await history(HISTORY, true);
    expect(r.committed).toBe(false);
    expect(r.errors).toHaveLength(4);
    expect(r.errors[0]!.message).toBe('This event is already in the journey');
    expect(await migrated()).toBe(4);
  });

  it('only those who may create people can load history', async () => {
    await agents
      .admin!.post('/api/imports/history', { csv: HISTORY, commit: false, recordedFrom: today })
      .expect(403);
    await agents
      .mgr!.post('/api/imports/history', { csv: HISTORY, commit: false, recordedFrom: today })
      .expect(403);
  });
});

describe('leave balances that must add up (slice 13 done-when #2; decision #95)', () => {
  const asOf = addDays(today, -1);
  const send = async (csv: string) =>
    (await agents.hr!.post('/api/leave/balances/import', { csv, asOf, commit: true }).expect(200))
      .body as LeaveImportResult;

  it('rejects a file whose parts don’t add up, and loads nothing', async () => {
    const r = await send(
      [
        'employee_code,leave_type,opening,accrued,taken,balance',
        'IDS-0100,CL,2,6,3,5',
        'IDS-0102,CL,1,6,3,5',
      ].join('\n'),
    );
    expect(r.committed).toBe(false);
    expect(r.errors).toEqual([
      { line: 3, message: "The balance doesn't add up: 1 + 6 − 3 = 4, not 5" },
    ]);
    const { rows } = await pool.query(
      `select count(*)::int as n from leave_ledger_entry where tenant_id = $1`,
      [tenant],
    );
    expect(rows[0].n).toBe(0);
  });

  it('loads it once the parts add up', async () => {
    const r = await send(
      [
        'employee_code,leave_type,opening,accrued,taken,balance',
        'IDS-0100,CL,2,6,3,5',
        'IDS-0102,CL,1,6,3,4',
      ].join('\n'),
    );
    expect(r).toMatchObject({ committed: true, errors: [] });
  });
});
