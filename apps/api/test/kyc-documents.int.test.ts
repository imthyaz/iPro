import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedOrg, seedOrgIds } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { OBJECT_STORAGE, type MemoryStorage } from '../src/storage/object-storage.js';
import { addUser, as, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

// Synthetic people and identifiers only (234123412346 is a Verhoeff-valid test number).
const HR = '00000000-0000-4000-8000-00000000c001';
const HR_HEAD = '00000000-0000-4000-8000-00000000c002';
const MANAGER = '00000000-0000-4000-8000-00000000c003';
const EMPLOYEE = '00000000-0000-4000-8000-00000000c004';
const CXO = '00000000-0000-4000-8000-00000000c005';
const email = (id: string) => `${id}@test.ipro.test`;
const PDF = Buffer.from('%PDF-1.4\n% synthetic test file\n');

const { pool, db } = testDb();
let app: INestApplication;
let hr: ReturnType<typeof as>;
let employeeCookie: string;
let employee: ReturnType<typeof as>;
let manager: ReturnType<typeof as>;
let employeePersonId: string;
let TENANT: string;
let org: ReturnType<typeof seedOrgIds>;

const person = (legalName: string, workEmail: string, managerEngagementId?: string) => ({
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
    managerEngagementId,
    bucket: 'billable',
  },
});

beforeAll(async () => {
  TENANT = await newTenant(pool, 'KYC tests');
  org = seedOrgIds(TENANT.slice(0, 8));
  await withTenant(db, TENANT, (tx) => seedOrg(tx, TENANT, TENANT.slice(0, 8)));
  await addUser(db, TENANT, HR, 'KYC HR', ['employee', 'hr']);
  await addUser(db, TENANT, HR_HEAD, 'KYC HR Head', ['employee', 'hr_head']);
  await addUser(db, TENANT, MANAGER, 'KYC Manager', ['employee', 'manager']);
  await addUser(db, TENANT, EMPLOYEE, 'KYC Employee', ['employee']);
  await addUser(db, TENANT, CXO, 'KYC CXO', ['employee', 'cxo']);
  app = await createTestApp({ TENANT_ID: TENANT });
  hr = as(app, await signIn(app, HR));
  const mgr = await hr.post('/api/people', person('Kavya Manager', email(MANAGER))).expect(201);
  const emp = await hr
    .post('/api/people', person('Karthik Employee', email(EMPLOYEE), mgr.body.engagementId))
    .expect(201);
  employeePersonId = emp.body.personId;
  employeeCookie = await signIn(app, EMPLOYEE);
  employee = as(app, employeeCookie);
  manager = as(app, await signIn(app, MANAGER));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const auditActions = async (table: string, actor?: string) => {
  const { rows } = await pool.query(
    `select action, created_by from audit_log where table_name = $1 and subject_person_id = $2
     ${actor ? 'and created_by = $3' : ''} order by at`,
    actor ? [table, employeePersonId, actor] : [table, employeePersonId],
  );
  return rows.map((r) => r.action as string);
};

describe('KYC (done-when #4)', () => {
  let panId: string;

  it('an employee submits their own PAN and sees it masked; every view is audited', async () => {
    const response = await employee
      .post(`/api/people/${employeePersonId}/kyc`, { type: 'pan', value: 'abcde 1234 f' })
      .expect(201);
    panId = response.body[0].id;
    expect(response.body).toEqual([
      expect.objectContaining({ type: 'pan', maskedValue: '••••••234F', verified: false }),
    ]);
    const { rows } = await pool.query(`select value_encrypted from kyc_record where id = $1`, [
      panId,
    ]);
    expect(rows[0].value_encrypted).not.toContain('ABCDE1234F');
    expect(await auditActions('kyc_record', EMPLOYEE)).toEqual(['create', 'view']);
  });

  it('nobody but HR and HR head can unmask; managers and CXO cannot even list', async () => {
    await employee.post(`/api/people/${employeePersonId}/kyc/${panId}/unmask`).expect(403);
    await manager.get(`/api/people/${employeePersonId}/kyc`).expect(403);
    const cxo = as(app, await signIn(app, CXO));
    await cxo.get(`/api/people/${employeePersonId}/kyc`).expect(403);
  });

  it('HR sees it masked, and an unmask returns the value and writes an unmask audit row', async () => {
    const list = await hr.get(`/api/people/${employeePersonId}/kyc`).expect(200);
    expect(list.body[0].maskedValue).toBe('••••••234F');
    const unmasked = await hr
      .post(`/api/people/${employeePersonId}/kyc/${panId}/unmask`)
      .expect(201);
    expect(unmasked.body).toEqual({ value: 'ABCDE1234F' });
    expect(await auditActions('kyc_record', HR)).toEqual(['view', 'unmask']);
    const hrHead = as(app, await signIn(app, HR_HEAD));
    await hrHead.post(`/api/people/${employeePersonId}/kyc/${panId}/unmask`).expect(201);
    expect(await auditActions('kyc_record', HR_HEAD)).toEqual(['unmask']);
  });

  it('once HR verifies a value, only HR can replace it', async () => {
    const verified = await hr
      .post(`/api/people/${employeePersonId}/kyc/${panId}/verify`)
      .expect(201);
    expect(verified.body[0]).toMatchObject({ verified: true });
    await employee
      .post(`/api/people/${employeePersonId}/kyc`, { type: 'pan', value: 'ZZZZZ9999Z' })
      .expect(409);
    const replaced = await hr
      .post(`/api/people/${employeePersonId}/kyc`, { type: 'pan', value: 'ZZZZZ9999Z' })
      .expect(201);
    expect(replaced.body).toEqual([
      expect.objectContaining({ maskedValue: '••••••999Z', verified: false }),
    ]);
    const { rows } = await pool.query(
      `select count(*)::int as n from kyc_record where person_id = $1 and type = 'pan' and deleted_at is not null`,
      [employeePersonId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('validates values by type', async () => {
    await employee
      .post(`/api/people/${employeePersonId}/kyc`, { type: 'aadhaar', value: '234123412347' })
      .expect(400);
    await employee
      .post(`/api/people/${employeePersonId}/kyc`, { type: 'aadhaar', value: '2341 2341 2346' })
      .expect(201);
  });
});

describe('documents', () => {
  let scanId: string;

  it('an employee uploads their own KYC scan; the storage key holds ids only', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/people/${employeePersonId}/documents`)
      .set('Cookie', employeeCookie)
      .field('type', 'kyc_scan')
      .field('title', 'PAN card')
      .attach('file', PDF, { filename: '../../Karthik PAN.pdf', contentType: 'application/pdf' })
      .expect(201);
    scanId = response.body.id;
    expect(response.body).toMatchObject({
      type: 'kyc_scan',
      fileName: 'Karthik PAN.pdf',
      contentType: 'application/pdf',
      confidential: true,
    });
    const storage = app.get<MemoryStorage>(OBJECT_STORAGE);
    const [key] = [...storage.objects.keys()];
    expect(key).toMatch(new RegExp(`^${TENANT}/people/${employeePersonId}/${scanId}$`));
  });

  it('refuses files that are not PDF, JPEG or PNG, whatever they claim to be', async () => {
    await request(app.getHttpServer())
      .post(`/api/people/${employeePersonId}/documents`)
      .set('Cookie', employeeCookie)
      .field('type', 'kyc_scan')
      .field('title', 'Not a PDF')
      .attach('file', Buffer.from('MZ\x90\x00 fake exe'), {
        filename: 'scan.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
  });

  it('managers see non-confidential team documents but never KYC scans', async () => {
    const hrCookie = await signIn(app, HR);
    await request(app.getHttpServer())
      .post(`/api/people/${employeePersonId}/documents`)
      .set('Cookie', hrCookie)
      .field('type', 'certificate')
      .field('title', 'Course certificate')
      .field('confidential', 'false')
      .attach('file', PDF, { filename: 'certificate.pdf', contentType: 'application/pdf' })
      .expect(201);
    const list = await manager.get(`/api/people/${employeePersonId}/documents`).expect(200);
    expect(list.body.map((d: { title: string }) => d.title)).toEqual(['Course certificate']);
    await manager.post(`/api/people/${employeePersonId}/documents/${scanId}/link`).expect(404);
  });

  it('opening a KYC scan is an audited unmask: HR may, the employee may not', async () => {
    const link = await hr
      .post(`/api/people/${employeePersonId}/documents/${scanId}/link`)
      .expect(201);
    expect(link.body).toMatchObject({ expiresInSeconds: 300 });
    expect(link.body.url).toMatch(/^memory:\/\//);
    expect(await auditActions('document', HR)).toContain('unmask');
    await employee.post(`/api/people/${employeePersonId}/documents/${scanId}/link`).expect(404);
  });
});
