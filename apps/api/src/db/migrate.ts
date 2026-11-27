import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { pgSsl } from './pg-options.js';

/**
 * Deploy-time migrations (decision #100): runs in its own container before the API starts in every new
 * task. An advisory lock lets only one task migrate at a time; the others wait, then find nothing to
 * do. Also makes sure this deployment's tenant row exists (Phase 1 runs one tenant per deployment,
 * decision #30). Logs counts only.
 */
const MIGRATION_LOCK = 7_141_400; // any fixed number, shared by every task

export async function runMigrations(
  connectionString: string,
  ssl: ReturnType<typeof pgSsl>,
  tenant: { id: string; name: string },
): Promise<number> {
  const pool = new pg.Pool({ connectionString, ssl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    const before = await applied(client);
    await migrate(drizzle({ client }), {
      migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
    });
    await client.query(
      `insert into tenant (id, name) values ($1, $2) on conflict (id) do nothing`,
      [tenant.id, tenant.name],
    );
    return (await applied(client)) - before;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

async function applied(client: pg.PoolClient): Promise<number> {
  const exists = await client.query<{ t: string | null }>(
    "select to_regclass('drizzle.__drizzle_migrations')::text as t",
  );
  if (!exists.rows[0]!.t) return 0;
  const { rows } = await client.query<{ n: number }>(
    'select count(*)::int as n from drizzle.__drizzle_migrations',
  );
  return rows[0]!.n;
}
