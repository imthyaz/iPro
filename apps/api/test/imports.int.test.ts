import type { INestApplication } from '@nestjs/common';
import type { ImportResult, PersonSummary } from '@ipro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '../src/common/effective-dating.js';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people only, as an old system's export would have them.
const U = {
  admin: '00000000-0000-4000-8000-000000695001',
  hr: '00000000-0000-4000-8000-000000695002',
  hrHead: '00000000-0000-4000-8000-000000695003',
  mgr: '00000000-0000-4000-8000-000000695004',
  emp: '00000000-0000-4000-8000-000000695005',
};
type Who = keyof typeof U;
const today = businessDate(new Date());

const { pool, db } = testDb();
let app: INestApplication;
let tenant: string;
let org: ReturnType<typeof seedOrgIds>;
const agents: Record<string, ReturnType<typeof as>> = {};

const HEADER =
  'employee_code,legal_name,work_email,engagement_type,joining_date,confirmation_date,status,last_working_date,exit_reason,designation,department,location,manager_code,bucket,ctc_amount,ctc_rate_unit';
const GOOD = [
  HEADER,
  // A report listed before their manager: the import loads managers first.
  'IDS-0102,Chitra Report,chitra@old.test,permanent,2024-06-01,2024-12-01,active,,,Software Engineer,Engineering,Chennai office,IDS-0100,billable,"6,00,000",year',
  'IDS-0100,Anbu Lead,anbu@old.test,permanent,2023-04-10,2023-10-10,active,,,Software Engineer,Engineering,Chennai office,,billable,"12,00,000",year',
  'IDS-0101,Bala Left,bala@old.test,permanent,2023-05-01,,exited,2025-09-30,resigned,Software Engineer,Quality Engineering,Chennai office,IDS-0100,billable,,',
  `IDS-0103,Devi Notice,devi@old.test,permanent,2024-01-15,2024-07-15,on_notice,${addDays(today, 30)},resigned,Software Engineer,Engineering,Chennai office,IDS-0100,billable,,`,
].join('\n');

const send = async (who: Who, path: string, csv: string, commit: boolean) =>
  (await agents[who]!.post(`/api/imports/${path}`, { csv, commit }).expect(200))
    .body as ImportResult;
const count = async () =>
  (await pool.query(`select count(*)::int as n from engagement where tenant_id = $1`, [tenant]))
    .rows[0].n as number;
const byCode = async (code: string) =>
  (
    await pool.query(
      `select e.id, e.person_id, e.status, e.last_working_date::text as last_working_date,
         e.confirmation_date::text as confirmation_date, p.legal_name
         from engagement e join person p on p.id = e.person_id
        where e.tenant_id = $1 and e.employee_code = $2`,
      [tenant, code],
    )
  ).rows[0];

beforeAll(async () => {
  tenant = await newTenant(pool, 'Import tests');
  org = seedOrgIds(tenant.slice(0, 8));
  await withTenant(db, tenant, (tx) => seedOrg(tx, tenant, tenant.slice(0, 8)));
  await addUser(db, tenant, U.admin, 'Im Admin', ['admin']);
  await addUser(db, tenant, U.hr, 'Im HR', ['employee', 'hr']);
  await addUser(db, tenant, U.hrHead, 'Im HR Head', ['employee', 'hr_head']);
  await addUser(db, tenant, U.mgr, 'Im Manager', ['employee', 'manager']);
  await addUser(db, tenant, U.emp, 'Im Employee', ['employee']);
  app = await createTestApp({ TENANT_ID: tenant });
  for (const [key, id] of Object.entries(U)) agents[key] = as(app, await signIn(app, id));
}, 120_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('the A6 people import (slice 13 done-when #2; decision #94)', () => {
  it('a check reports a clean file and loads nothing', async () => {
    const before = await count();
    const r = await send('hr', 'people', GOOD, false);
    expect(r).toEqual({ committed: false, rows: 4, ready: 4, errors: [] });
    expect(await count()).toBe(before);
  });

  it('rejects duplicates, missing managers and invalid dates, and loads nothing', async () => {
    const bad = [
      HEADER,
      'IDS-0200,One,one@old.test,permanent,2024-01-01,,active,,,Software Engineer,Engineering,Chennai office,,billable,,',
      'IDS-0200,Two,two@old.test,permanent,2024-01-01,,active,,,Software Engineer,Engineering,Chennai office,,billable,,',
      'IDS-0201,Three,three@old.test,permanent,2024-01-01,,active,,,Software Engineer,Engineering,Chennai office,IDS-0999,billable,,',
      'IDS-0202,Four,four@old.test,permanent,2024-13-01,,active,,,Software Engineer,Engineering,Chennai office,,billable,,',
      'IDS-0203,Five,five@old.test,permanent,2024-01-01,,exited,2023-01-01,,Software Engineer,Engineering,Chennai office,,billable,,',
    ].join('\n');
    const before = await count();
    const r = await send('hr', 'people', bad, true);
    expect(r.committed).toBe(false);
    expect(r.errors).toEqual([
      { line: 3, message: 'Duplicate employee_code IDS-0200 (also on line 2)' },
      { line: 4, message: "Manager IDS-0999 isn't in the file or in iPro" },
      { line: 5, message: "joining_date 2024-13-01 isn't a real date (use YYYY-MM-DD)" },
      { line: 6, message: 'last_working_date is before joining_date' },
    ]);
    expect(await count()).toBe(before);
  });

  it('also reports what the people service refuses, and still loads nothing', async () => {
    // The org was set up from April 2023: a 2020 joiner has no department in force then.
    const early = [
      HEADER,
      'IDS-0300,Early Bird,early@old.test,permanent,2020-01-06,,active,,,Software Engineer,Engineering,Chennai office,,billable,,',
      'IDS-0301,On Time,ontime@old.test,permanent,2024-01-08,,active,,,Software Engineer,Engineering,Chennai office,,billable,,',
    ].join('\n');
    const before = await count();
    const r = await send('hr', 'people', early, true);
    expect(r).toMatchObject({
      committed: false,
      ready: 1,
      errors: [{ line: 2, message: 'Department is not in force on that date' }],
    });
    expect(await count()).toBe(before);
  });

  it('loads a clean file: codes, managers, statuses and pay as in the old system', async () => {
    const r = await send('hr', 'people', GOOD, true);
    expect(r).toEqual({ committed: true, rows: 4, ready: 4, errors: [] });
    const anbu = await byCode('IDS-0100');
    const chitra = await byCode('IDS-0102');
    const bala = await byCode('IDS-0101');
    const devi = await byCode('IDS-0103');
    expect([anbu.status, chitra.status, bala.status, devi.status]).toEqual([
      'active',
      'active',
      'exited',
      'on_notice',
    ]);
    expect(bala.last_working_date).toBe('2025-09-30');
    expect(chitra.confirmation_date).toBe('2024-12-01');
    const { rows: managers } = await pool.query(
      `select manager_engagement_id from assignment where engagement_id = $1`,
      [chitra.id],
    );
    expect(managers[0].manager_engagement_id).toBe(anbu.id);
    // Joining events are marked migrated (decision #94).
    const { rows: events } = await pool.query(
      `select migrated from journal_event where engagement_id = $1 and event_type = 'joined'`,
      [anbu.id],
    );
    expect(events).toEqual([{ migrated: true }]);
    // Pay is stored encrypted and read back as entered.
    const pay = (await agents.hrHead!.get(`/api/people/${anbu.person_id}/compensation`).expect(200))
      .body as { amount: string; rateUnit: string }[];
    expect(pay[0]).toMatchObject({ amount: '120000000', rateUnit: 'year' });
  });

  it('the next hire continues after the highest imported code', async () => {
    const hired = (
      await agents
        .hr!.post('/api/people', {
          person: { legalName: 'New Joiner' },
          engagement: {
            legalEntityId: org.legalEntity,
            type: 'permanent',
            workEmail: 'new@old.test',
            joiningDate: addDays(today, -1),
          },
          assignment: {
            designationId: org.softwareEngineer,
            departmentId: org.engineering,
            locationId: org.chennai,
            bucket: 'billable',
          },
        })
        .expect(201)
    ).body as PersonSummary;
    expect(hired.employeeCode).toBe('IDS-0104');
  });

  it('a second load of the same file finds every code already in iPro', async () => {
    const r = await send('hr', 'people', GOOD, true);
    expect(r.committed).toBe(false);
    expect(r.errors.map((e) => e.message)).toContain('employee_code IDS-0100 is already in iPro');
  });

  it('only those who may create people can import', async () => {
    for (const who of ['admin', 'mgr', 'emp'] as const) {
      await agents[who]!.post('/api/imports/people', { csv: GOOD, commit: false }).expect(403);
    }
  });
});

describe('the KYC import', () => {
  const KYC = [
    'employee_code,type,value,ifsc',
    'IDS-0100,pan,ABCDE1234F,',
    'IDS-0100,bank,123456789012,HDFC0001234',
  ].join('\n');

  it('rejects unknown people, duplicates and bad values, and loads nothing', async () => {
    const r = await send(
      'hr',
      'kyc',
      [
        'employee_code,type,value,ifsc',
        'IDS-0999,pan,ABCDE1234F,',
        'IDS-0100,pan,ABCDE1234F,',
        'IDS-0100,pan,ABCDE1234F,',
        'IDS-0102,pan,NOTAPAN,',
      ].join('\n'),
      true,
    );
    expect(r.committed).toBe(false);
    expect(r.errors.map((e) => e.line)).toEqual([2, 4, 5]);
    expect(r.errors[0]!.message).toBe('No one with employee_code IDS-0999');
  });

  it('loads values encrypted, shown masked', async () => {
    const r = await send('hr', 'kyc', KYC, true);
    expect(r).toEqual({ committed: true, rows: 2, ready: 2, errors: [] });
    const anbu = await byCode('IDS-0100');
    const kyc = (await agents.hr!.get(`/api/people/${anbu.person_id}/kyc`).expect(200)).body as {
      type: string;
      masked: string;
    }[];
    expect(kyc.map((k) => k.type).sort()).toEqual(['bank', 'pan']);
    expect(JSON.stringify(kyc)).not.toContain('ABCDE1234F');
    const { rows } = await pool.query(
      `select count(*)::int as n from kyc_record where person_id = $1 and value_encrypted like '%ABCDE1234F%'`,
      [anbu.person_id],
    );
    expect(rows[0].n).toBe(0);
  });
});
