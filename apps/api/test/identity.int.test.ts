import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SensitiveReads, FIELD_CIPHER } from '../src/audit/audit.service.js';
import type { FieldCipher } from '../src/audit/field-cipher.js';
import { runWithContext, type Actor } from '../src/context/request-context.js';
import { withTenant } from '../src/db/tenant-context.js';
import * as schema from '../src/db/schema.js';
import { createTestApp } from './test-app.js';
import { TENANT_A, TENANT_B, TEST_DATABASE_URL } from './test-db.js';

// Synthetic users only.
const EMPLOYEE = '00000000-0000-4000-8000-00000000e001';
const MANAGER = '00000000-0000-4000-8000-00000000e002';
const MANAGER_TWO = '00000000-0000-4000-8000-00000000e003';
const HR = '00000000-0000-4000-8000-00000000e004';

const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
const db = drizzle({ client: pool, schema });
let app: INestApplication;

async function addUser(
  tenantId: string,
  id: string,
  name: string,
  roles: (typeof schema.roleValues)[number][],
) {
  await withTenant(db, tenantId, async (tx) => {
    await tx
      .insert(schema.appUsers)
      .values({ id, tenantId, email: `${id}@test.ipro.test`, displayName: name });
    await tx
      .insert(schema.roleAssignments)
      .values(roles.map((role) => ({ tenantId, userId: id, role, source: 'manual' as const })));
  });
}

/** Dev sign-in as a user; returns the session cookie. */
async function signIn(userId: string): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/auth/dev/login')
    .send({ userId })
    .expect(204);
  const cookie = response.headers['set-cookie']?.[0];
  expect(cookie).toMatch(/^ipro_session=.+HttpOnly; SameSite=Lax/);
  return cookie!.split(';')[0]!;
}

beforeAll(async () => {
  await addUser(TENANT_A, EMPLOYEE, 'Test Employee', ['employee']);
  await addUser(TENANT_A, MANAGER, 'Test Manager', ['employee', 'manager']);
  await addUser(TENANT_A, MANAGER_TWO, 'Test Manager Two', ['employee', 'manager']);
  await addUser(TENANT_A, HR, 'Test HR', ['employee', 'hr']);
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('row-level security', () => {
  it('a tenant cannot see or write another tenant’s rows', async () => {
    const visibleFromB = await withTenant(db, TENANT_B, (tx) => tx.select().from(schema.appUsers));
    expect(visibleFromB.some((user) => user.tenantId === TENANT_A)).toBe(false);
    expect(visibleFromB.some((user) => user.id === EMPLOYEE)).toBe(false);
    const error = await withTenant(db, TENANT_B, (tx) =>
      tx
        .insert(schema.appUsers)
        .values({ tenantId: TENANT_A, email: 'x@test.ipro.test', displayName: 'X' }),
    ).catch((e: unknown) => e);
    // Drizzle wraps the Postgres error; the cause says why it was refused.
    expect((error as Error).cause).toMatchObject({
      message: expect.stringMatching(/row-level security/),
    });
  });

  it('nothing is visible without a tenant context', async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role ipro_app`);
      return tx.select().from(schema.appUsers);
    });
    expect(rows).toEqual([]);
  });
});

describe('audit log', () => {
  it('is append-only', async () => {
    await withTenant(db, TENANT_A, (tx) =>
      tx.insert(schema.auditLog).values({ tenantId: TENANT_A, action: 'view', tableName: 'test' }),
    );
    await expect(
      withTenant(db, TENANT_A, (tx) => tx.update(schema.auditLog).set({ tableName: 'changed' })),
    ).rejects.toThrow();
    await expect(withTenant(db, TENANT_A, (tx) => tx.delete(schema.auditLog))).rejects.toThrow();
    // Even the owner cannot rewrite history.
    await expect(pool.query(`update audit_log set table_name = 'changed'`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('KYC and compensation reads write audit rows with actor and time (done-when #2)', async () => {
    const cipher = app.get<FieldCipher>(FIELD_CIPHER);
    const reads = app.get(SensitiveReads);
    const hr: Actor = {
      userId: HR,
      tenantId: TENANT_A,
      personId: null,
      roles: [{ role: 'hr', legalEntityId: null }],
    };
    const kyc = {
      table: 'kyc_record',
      column: 'value_encrypted',
      recordId: '00000000-0000-4000-8000-0000000000f1',
    };
    const comp = {
      table: 'compensation',
      column: 'annual_ctc_encrypted',
      recordId: '00000000-0000-4000-8000-0000000000f2',
    };

    await runWithContext({ tenantId: TENANT_A, actor: hr }, async () => {
      const kycStored = await cipher.encrypt(TENANT_A, 'ABCDE1234F', kyc);
      const compStored = await cipher.encrypt(TENANT_A, '120000000', comp);
      await withTenant(db, TENANT_A, async (tx) => {
        await reads.kyc(tx, { ...kyc, stored: kycStored, subjectPersonId: null }, 'masked');
        await reads.kyc(tx, { ...kyc, stored: kycStored, subjectPersonId: null }, 'unmask');
        await reads.compensation(tx, { ...comp, stored: compStored, subjectPersonId: null });
      });
    });

    const rows = await withTenant(db, TENANT_A, (tx) =>
      tx
        .select()
        .from(schema.auditLog)
        .where(sql`${schema.auditLog.tableName} in ('kyc_record', 'compensation')`),
    );
    expect(rows.map((row) => [row.tableName, row.action, row.createdBy])).toEqual([
      ['kyc_record', 'view', HR],
      ['kyc_record', 'unmask', HR],
      ['compensation', 'view', HR],
    ]);
    expect(rows.every((row) => row.at instanceof Date)).toBe(true);
  });
});

describe('sign-in and sessions', () => {
  it('dev sign-in, /me, sign-out', async () => {
    const cookie = await signIn(EMPLOYEE);
    const me = await request(app.getHttpServer()).get('/api/me').set('Cookie', cookie).expect(200);
    expect(me.body).toEqual({
      userId: EMPLOYEE,
      displayName: 'Test Employee',
      roles: [{ role: 'employee', legalEntityId: null }],
      personId: null,
    });
    await request(app.getHttpServer()).post('/api/auth/logout').set('Cookie', cookie).expect(204);
    await request(app.getHttpServer()).get('/api/me').set('Cookie', cookie).expect(401);
  });

  it('stores only the token hash', async () => {
    const cookie = await signIn(EMPLOYEE);
    const token = cookie.split('=')[1]!;
    const { rows } = await pool.query(
      `select count(*)::int as n from session where token_hash = $1`,
      [token],
    );
    expect(rows[0].n).toBe(0);
  });

  it('rejects unknown sessions and unknown dev users', async () => {
    await request(app.getHttpServer())
      .get('/api/me')
      .set('Cookie', 'ipro_session=forged')
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/auth/dev/login')
      .send({ userId: '00000000-0000-4000-8000-00000000dead' })
      .expect(404);
  });
});

describe('delegation (done-when #3)', () => {
  const nextMonth = (day: number) => {
    const date = new Date();
    date.setUTCMonth(date.getUTCMonth() + 1, day);
    return date.toISOString().slice(0, 10);
  };

  it('a manager delegates approvals to another manager for a date range, and can revoke it', async () => {
    const cookie = await signIn(MANAGER);
    const created = await request(app.getHttpServer())
      .post('/api/delegations')
      .set('Cookie', cookie)
      .send({
        delegateUserId: MANAGER_TWO,
        startsOn: nextMonth(3),
        endsOn: nextMonth(7),
        reason: 'On leave',
      })
      .expect(201);
    expect(created.body).toMatchObject({ delegatorUserId: MANAGER, delegateUserId: MANAGER_TWO });

    const overlapping = await request(app.getHttpServer())
      .post('/api/delegations')
      .set('Cookie', cookie)
      .send({ delegateUserId: MANAGER_TWO, startsOn: nextMonth(5), endsOn: nextMonth(9) })
      .expect(400);
    expect(overlapping.body.problems).toContain('Overlaps an existing delegation');

    const list = await request(app.getHttpServer())
      .get('/api/delegations')
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body).toHaveLength(1);

    const revoked = await request(app.getHttpServer())
      .post(`/api/delegations/${created.body.id}/revoke`)
      .set('Cookie', cookie)
      .expect(201);
    expect(revoked.body.revokedAt).not.toBeNull();
  });

  it('an employee without the manager role cannot delegate', async () => {
    const cookie = await signIn(EMPLOYEE);
    await request(app.getHttpServer())
      .post('/api/delegations')
      .set('Cookie', cookie)
      .send({ delegateUserId: MANAGER, startsOn: nextMonth(3), endsOn: nextMonth(4) })
      .expect(403);
  });

  it('HR can set up a delegation on a manager’s behalf', async () => {
    const cookie = await signIn(HR);
    await request(app.getHttpServer())
      .post('/api/delegations')
      .set('Cookie', cookie)
      .send({
        delegatorUserId: MANAGER_TWO,
        delegateUserId: MANAGER,
        startsOn: nextMonth(10),
        endsOn: nextMonth(12),
      })
      .expect(201);
  });

  it('a manager cannot create a delegation for someone else', async () => {
    const cookie = await signIn(MANAGER);
    await request(app.getHttpServer())
      .post('/api/delegations')
      .set('Cookie', cookie)
      .send({
        delegatorUserId: MANAGER_TWO,
        delegateUserId: MANAGER,
        startsOn: nextMonth(20),
        endsOn: nextMonth(21),
      })
      .expect(403);
  });

  it('every delegation change is audited', async () => {
    const rows = await withTenant(db, TENANT_A, (tx) =>
      tx
        .select()
        .from(schema.auditLog)
        .where(sql`${schema.auditLog.tableName} = 'approval_delegation'`),
    );
    expect(rows.map((row) => row.action).sort()).toEqual(['create', 'create', 'update']);
  });
});
