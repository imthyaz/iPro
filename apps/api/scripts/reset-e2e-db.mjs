// Local end-to-end runs get their own database, rebuilt each run like CI's, so leftovers from earlier
// runs (and the developer's own dev data) never affect them. Synthetic seed data only.
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const url = new URL(process.env.E2E_DATABASE_URL ?? 'postgres://ipro:ipro@localhost:5432/ipro_e2e');
const name = url.pathname.slice(1);
if (!/^[a-z0-9_]+_e2e$/.test(name)) {
  throw new Error('The end-to-end database name must end in _e2e (it is dropped and recreated)');
}

const admin = new URL(url);
admin.pathname = '/postgres';
const client = new pg.Client({ connectionString: admin.href });
await client.connect();
await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
await client.query(`CREATE DATABASE ${name}`);
await client.end();

const env = { ...process.env, DATABASE_URL: url.href };
for (const args of [
  ['--filter', '@ipro/api', 'db:migrate'],
  ['-w', 'db:seed'],
]) {
  const run = spawnSync('pnpm', args, { env, stdio: 'inherit', shell: true });
  if (run.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed`);
}
