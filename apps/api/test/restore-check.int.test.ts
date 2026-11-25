import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { seedOrg } from '../src/db/seed-org.js';
import { withTenant } from '../src/db/tenant-context.js';
import { compareManifests, takeManifest } from '../src/ops/restore-check.js';
import { TEST_DATABASE_URL } from './test-db.js';

/**
 * Slice 14c (decision #98): a restored copy of a database passes the check, and a copy missing a row
 * fails it. The "restore" is a Postgres copy of a freshly migrated and seeded database, which is what
 * an RDS restore gives back. Synthetic data only.
 */
const url = (db: string) => {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${db}`;
  return u.href;
};
const SOURCE = 'ipro_restore_src_test';
const COPY = 'ipro_restore_copy_test';
const TENANT = '00000000-0000-4000-8000-00000000a14c';
const admin = new pg.Pool({ connectionString: url('postgres') });
let cutoff: Date;

async function recreate(name: string, template?: string) {
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}${template ? ` template ${template}` : ''}`);
}

beforeAll(async () => {
  await recreate(SOURCE);
  const pool = new pg.Pool({ connectionString: url(SOURCE) });
  try {
    const db = drizzle({ client: pool, schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    await pool.query(`insert into tenant (id, name) values ($1, 'Restore test tenant')`, [TENANT]);
    await withTenant(db, TENANT, (tx) => seedOrg(tx, TENANT, 'a14c0000'));
  } finally {
    await pool.end();
  }
  cutoff = new Date();
  // What a restore gives back: the same database, at that point.
  await recreate(COPY, SOURCE);
}, 120_000);

afterAll(async () => {
  await admin.query(`drop database if exists ${COPY} with (force)`);
  await admin.query(`drop database if exists ${SOURCE} with (force)`);
  await admin.end();
});

describe('restore check (slice 14 done-when #4; decision #98)', () => {
  it('a faithful copy matches: every tenant table, every row, every migration', async () => {
    const source = await takeManifest(url(SOURCE), cutoff);
    const restored = await takeManifest(url(COPY), cutoff);
    expect(Object.keys(source.tenants[TENANT]!).length).toBeGreaterThan(3);
    expect(source.migrations.length).toBeGreaterThan(60);
    expect(compareManifests(source, restored)).toEqual([]);
    // Ids, counts and hashes only.
    expect(JSON.stringify(source)).not.toMatch(/Engineering|Chennai/);
  });

  it('rows created after the cut-off are ignored', async () => {
    // A copy of a location created after the cut-off, in the source only.
    const pool = new pg.Pool({ connectionString: url(SOURCE) });
    await pool.query(`create temp table later as select * from location limit 1`);
    await pool.query(`update later set id = gen_random_uuid(), code = 'LATER', created_at = now()`);
    await pool.query(`insert into location select * from later`);
    await pool.end();
    const source = await takeManifest(url(SOURCE), cutoff);
    const restored = await takeManifest(url(COPY), cutoff);
    expect(compareManifests(source, restored)).toEqual([]);
  });

  it('a copy missing a row fails, naming the table', async () => {
    const pool = new pg.Pool({ connectionString: url(COPY) });
    const { rows } = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'tenant_id' and table_name = 'location_version'`,
    );
    expect(rows).toHaveLength(1);
    await pool.query(
      `delete from location_version where id = (select id from location_version limit 1)`,
    );
    await pool.end();
    const problems = compareManifests(
      await takeManifest(url(SOURCE), cutoff),
      await takeManifest(url(COPY), cutoff),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^Tenant .*: location_version has \d+ rows \(expected \d+\)$/);
  });
});
