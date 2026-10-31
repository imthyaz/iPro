import type { INestApplication } from '@nestjs/common';
import type { Role } from '@ipro/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import request from 'supertest';
import { expect } from 'vitest';
import * as schema from '../src/db/schema.js';
import { withTenant } from '../src/db/tenant-context.js';
import { TEST_DATABASE_URL } from './test-db.js';

export function testDb() {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  return { pool, db: drizzle({ client: pool, schema }) };
}

/** A synthetic sign-in user with manual roles. */
export async function addUser(
  db: ReturnType<typeof testDb>['db'],
  tenantId: string,
  id: string,
  name: string,
  roles: Role[],
): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    await tx
      .insert(schema.appUsers)
      .values({ id, tenantId, email: `${id}@test.ipro.test`, displayName: name });
    await tx
      .insert(schema.roleAssignments)
      .values(roles.map((role) => ({ tenantId, userId: id, role, source: 'manual' as const })));
  });
}

/** Dev sign-in as a user; returns the session cookie for supertest. */
export async function signIn(app: INestApplication, userId: string): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/auth/dev/login')
    .send({ userId })
    .expect(204);
  const cookie = response.headers['set-cookie']?.[0];
  expect(cookie).toMatch(/^ipro_session=.+HttpOnly; SameSite=Lax/);
  return cookie!.split(';')[0]!;
}

/** supertest agent bound to a signed-in user. */
export function as(app: INestApplication, cookie: string) {
  const server = app.getHttpServer();
  return {
    get: (url: string) => request(server).get(url).set('Cookie', cookie),
    post: (url: string, body?: object) =>
      request(server).post(url).set('Cookie', cookie).send(body),
    patch: (url: string, body?: object) =>
      request(server).patch(url).set('Cookie', cookie).send(body),
    delete: (url: string) => request(server).delete(url).set('Cookie', cookie),
  };
}

/** A fresh tenant for one test file, so files don't share counters or data. */
export async function newTenant(pool: pg.Pool, name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into tenant (name) values ($1) returning id`,
    [name],
  );
  return rows[0]!.id;
}
