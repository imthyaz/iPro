import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { TEST_DATABASE_URL } from './test-db.js';

/**
 * Deploy-time migrations (decision #100): a fresh database is migrated and gets its tenant; tasks
 * starting together don't trip over each other; running again changes nothing.
 */
const url = (db: string) => {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${db}`;
  return u.href;
};
const NAME = 'ipro_migrate_test';
const TENANT = { id: '00000000-0000-4000-8000-00000000d100', name: 'Deploy test tenant' };
const admin = new pg.Pool({ connectionString: url('postgres') });

afterAll(async () => {
  await admin.query(`drop database if exists ${NAME} with (force)`);
  await admin.end();
});

describe('runMigrations (decision #100)', () => {
  it('migrates a fresh database once, even when three tasks start together', async () => {
    await admin.query(`drop database if exists ${NAME} with (force)`);
    await admin.query(`create database ${NAME}`);
    const runs = await Promise.all([1, 2, 3].map(() => runMigrations(url(NAME), false, TENANT)));
    expect(runs.filter((n) => n > 0)).toHaveLength(1);
    expect(runs.reduce((a, b) => a + b, 0)).toBeGreaterThan(60);

    const db = new pg.Pool({ connectionString: url(NAME) });
    const { rows } = await db.query(`select id, name from tenant`);
    await db.end();
    expect(rows).toEqual([TENANT]);
  }, 120_000);

  it('running again applies nothing and keeps the tenant', async () => {
    expect(await runMigrations(url(NAME), false, { ...TENANT, name: 'Renamed' })).toBe(0);
    const db = new pg.Pool({ connectionString: url(NAME) });
    const { rows } = await db.query(`select name from tenant`);
    await db.end();
    expect(rows).toEqual([{ name: TENANT.name }]);
  });
});
