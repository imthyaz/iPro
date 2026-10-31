import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { TEST_DATABASE_URL } from './test-db.js';

/** Rebuilds the test database from the committed migrations, so tests prove the migrations too. */
export default async function setup(): Promise<void> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await pool.query('drop schema if exists public cascade');
    await pool.query('drop schema if exists drizzle cascade');
    await pool.query('drop schema if exists pgboss cascade');
    await pool.query('create schema public');
    await migrate(drizzle({ client: pool }), {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
  } catch (error) {
    // Vitest 5 can fail while printing global-setup errors, so state the cause plainly first.
    const detail =
      error instanceof AggregateError ? error.errors.map(String).join('; ') : String(error);
    process.stderr.write(`\nIntegration setup failed: ${detail}\n`);
    throw new Error(
      'Integration tests need Postgres at TEST_DATABASE_URL (start it with `docker compose up -d`)',
      { cause: error },
    );
  } finally {
    await pool.end();
  }
}
