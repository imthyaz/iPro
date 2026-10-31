// Synthetic seed data only. Never put real Ideassion people data here.
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { loadConfig } from '../config.js';
import * as schema from './schema.js';

export const DEV_TENANT_ID = '00000000-0000-4000-8000-000000000001';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const db = drizzle({ client: pool, schema });

await db
  .insert(schema.tenants)
  .values({ id: DEV_TENANT_ID, name: 'Ideassion (dev)' })
  .onConflictDoNothing();

await pool.end();
process.stdout.write(`Seeded tenant ${DEV_TENANT_ID}\n`);
