import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { withTenant } from '../src/db/tenant-context.js';
import { addUser, as, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';
import { TENANT_A } from './test-db.js';

// Synthetic org data only.
const ADMIN = '00000000-0000-4000-8000-00000000a001';
const HR = '00000000-0000-4000-8000-00000000a002';
const EMPLOYEE = '00000000-0000-4000-8000-00000000a003';

const { pool, db } = testDb();
let app: INestApplication;
let admin: ReturnType<typeof as>;

beforeAll(async () => {
  await addUser(db, TENANT_A, ADMIN, 'Org Admin', ['admin']);
  await addUser(db, TENANT_A, HR, 'Org HR', ['employee', 'hr']);
  await addUser(db, TENANT_A, EMPLOYEE, 'Org Employee', ['employee']);
  app = await createTestApp();
  admin = as(app, await signIn(app, ADMIN));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('organisation setup (A1)', () => {
  let legalEntityId: string;
  let businessUnitId: string;
  let engineeringId: string;

  it('creates a legal entity, a business unit and departments', async () => {
    const entity = await admin
      .post('/api/org/catalog/legal-entities', { name: 'Test Entity Pvt Ltd', pan: 'AAAAA0000A' })
      .expect(201);
    legalEntityId = entity.body.id;
    expect(entity.body).toMatchObject({ country: 'IN', defaultCurrency: 'INR' });
    expect(entity.body).not.toHaveProperty('tenantId');

    const bu = await admin
      .post('/api/org/units/business-units', {
        code: 'DEL',
        name: 'Delivery',
        effectiveFrom: '2024-01-01',
      })
      .expect(201);
    businessUnitId = bu.body.id;

    const eng = await admin
      .post('/api/org/units/departments', {
        code: 'ENG',
        name: 'Engineering',
        businessUnitId,
        effectiveFrom: '2024-01-01',
      })
      .expect(201);
    engineeringId = eng.body.id;
    expect(eng.body).toMatchObject({ code: 'ENG', effectiveFrom: '2024-01-01', effectiveTo: null });
  });

  it('a rename effective later keeps the old name for past dates', async () => {
    await admin
      .post(`/api/org/units/departments/${engineeringId}/changes`, {
        effectiveFrom: '2026-04-01',
        name: 'Product Engineering',
      })
      .expect(201);
    const before = await admin.get('/api/org/units/departments?asOf=2026-03-31').expect(200);
    const after = await admin.get('/api/org/units/departments?asOf=2026-04-01').expect(200);
    expect(before.body.find((d: { id: string }) => d.id === engineeringId).name).toBe(
      'Engineering',
    );
    expect(after.body.find((d: { id: string }) => d.id === engineeringId)).toMatchObject({
      name: 'Product Engineering',
      businessUnitId, // carried forward
    });
    const history = await admin
      .get(`/api/org/units/departments/${engineeringId}/versions`)
      .expect(200);
    expect(
      history.body.map((v: { effectiveFrom: string; effectiveTo: string | null }) => [
        v.effectiveFrom,
        v.effectiveTo,
      ]),
    ).toEqual([
      ['2024-01-01', '2026-03-31'],
      ['2026-04-01', null],
    ]);
  });

  it('refuses two versions starting the same day, and the database refuses overlaps', async () => {
    await admin
      .post(`/api/org/units/departments/${engineeringId}/changes`, {
        effectiveFrom: '2026-04-01',
        name: 'X',
      })
      .expect(400);
    await expect(
      withTenant(db, TENANT_A, (tx) =>
        tx.insert(schema.departmentVersions).values({
          tenantId: TENANT_A,
          departmentId: engineeringId,
          businessUnitId,
          name: 'Overlap',
          effectiveFrom: '2025-01-01',
          effectiveTo: '2025-12-31',
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a department cycle', async () => {
    const qa = await admin
      .post('/api/org/units/departments', {
        code: 'QA',
        name: 'Quality',
        businessUnitId,
        parentDepartmentId: engineeringId,
        effectiveFrom: '2024-01-01',
      })
      .expect(201);
    await admin
      .post(`/api/org/units/departments/${engineeringId}/changes`, {
        effectiveFrom: '2026-06-01',
        parentDepartmentId: qa.body.id,
      })
      .expect(400);
  });

  it('closes a location on a date', async () => {
    const loc = await admin
      .post('/api/org/units/locations', {
        code: 'CHN',
        name: 'Chennai office',
        type: 'office',
        legalEntityId,
        seatCount: 80,
        effectiveFrom: '2024-01-01',
      })
      .expect(201);
    await admin
      .post(`/api/org/units/locations/${loc.body.id}/close`, { effectiveTo: '2026-12-31' })
      .expect(201);
    const later = await admin.get('/api/org/units/locations?asOf=2027-01-01').expect(200);
    expect(later.body.some((l: { id: string }) => l.id === loc.body.id)).toBe(false);
  });

  it('stores money as paise and returns it as digit strings', async () => {
    const grade = await admin
      .post('/api/org/catalog/grades', {
        code: 'G5',
        name: 'Senior',
        bandMin: '120000000',
        bandMax: '180000000',
        levelOrder: 5,
      })
      .expect(201);
    expect(grade.body).toMatchObject({
      bandMin: '120000000',
      bandMax: '180000000',
      currency: 'INR',
    });
    await admin
      .post('/api/org/catalog/grades', {
        code: 'G6',
        name: 'Bad',
        bandMin: '2',
        bandMax: '1',
        levelOrder: 6,
      })
      .expect(400);
    await admin
      .post('/api/org/catalog/grades', {
        code: 'G7',
        name: 'Float',
        bandMin: '12.5',
        levelOrder: 7,
      })
      .expect(400);
  });

  it('updates catalog records partially and audits the field change', async () => {
    const grade = await admin
      .post('/api/org/catalog/grades', { code: 'G8', name: 'Lead', levelOrder: 8 })
      .expect(201);
    const updated = await admin
      .patch(`/api/org/catalog/grades/${grade.body.id}`, { name: 'Lead Engineer' })
      .expect(200);
    expect(updated.body).toMatchObject({ code: 'G8', name: 'Lead Engineer', levelOrder: 8 });
    const audit = await withTenant(db, TENANT_A, (tx) =>
      tx
        .select()
        .from(schema.auditLog)
        .where(sql`${schema.auditLog.recordId} = ${grade.body.id}`),
    );
    expect(audit.at(-1)?.fieldChanges).toEqual([
      { field: 'name', from: 'Lead', to: 'Lead Engineer' },
    ]);
  });

  it('a partial update leaves unsent fields alone (no defaults re-applied)', async () => {
    const grades = await admin.get('/api/org/catalog/grades').expect(200);
    const department = await admin.get('/api/org/units/departments').expect(200);
    const designation = await admin
      .post('/api/org/catalog/designations', {
        title: 'Engineer',
        gradeId: grades.body[0].id,
        designationBand: 'associate',
      })
      .expect(201);
    const position = await admin
      .post('/api/org/catalog/positions', {
        code: 'POS-1',
        designationId: designation.body.id,
        departmentId: department.body[0].id,
        status: 'frozen',
      })
      .expect(201);
    expect(position.body).toMatchObject({ status: 'frozen', currency: 'INR' });
    const updated = await admin
      .patch(`/api/org/catalog/positions/${position.body.id}`, { budgetedCtc: '150000000' })
      .expect(200);
    expect(updated.body).toMatchObject({ status: 'frozen', budgetedCtc: '150000000' });
  });

  it('soft-deletes and audits', async () => {
    const cc = await admin
      .post('/api/org/catalog/cost-centres', { code: 'CC1', name: 'Delivery CC' })
      .expect(201);
    await admin.delete(`/api/org/catalog/cost-centres/${cc.body.id}`).expect(204);
    const list = await admin.get('/api/org/catalog/cost-centres').expect(200);
    expect(list.body.some((c: { id: string }) => c.id === cc.body.id)).toBe(false);
    const { rows } = await pool.query(`select deleted_at from cost_centre where id = $1`, [
      cc.body.id,
    ]);
    expect(rows[0].deleted_at).not.toBeNull();
    const audit = await withTenant(db, TENANT_A, (tx) =>
      tx
        .select()
        .from(schema.auditLog)
        .where(sql`${schema.auditLog.recordId} = ${cc.body.id}`),
    );
    expect(audit.map((a) => a.action)).toEqual(['create', 'delete']);
  });

  it('follows the permissions table: HR reads, only admin changes, employees see nothing', async () => {
    const hr = as(app, await signIn(app, HR));
    await hr.get('/api/org/units/departments').expect(200);
    await hr.post('/api/org/catalog/cost-centres', { code: 'CC2', name: 'Nope' }).expect(403);
    const employee = as(app, await signIn(app, EMPLOYEE));
    await employee.get('/api/org/catalog/grades').expect(403);
    await admin.get('/api/org/catalog/unknown').expect(404);
  });
});
