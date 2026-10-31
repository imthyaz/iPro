import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { withTenant } from '../src/db/tenant-context.js';
import { TEST_DATABASE_URL } from './test-db.js';

const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
const db = drizzle({ client: pool, schema });

afterAll(() => pool.end());

describe('migrations', () => {
  it('create the tenant table with the standard audit columns', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'tenant'`,
    );
    expect(rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(['id', 'created_at', 'created_by', 'updated_at', 'updated_by']),
    );
  });

  it('store instants as timestamptz', async () => {
    const { rows } = await pool.query<{ data_type: string }>(
      `select data_type from information_schema.columns
       where table_name = 'tenant' and column_name = 'created_at'`,
    );
    expect(rows[0]?.data_type).toBe('timestamp with time zone');
  });
});

describe('withTenant', () => {
  const tenantId = '00000000-0000-4000-8000-0000000000aa';

  it('sets the tenant for the transaction only', async () => {
    const inside = await withTenant(db, tenantId, async (tx) => {
      const result = await tx.execute<{ tenant: string }>(
        sql`select app_current_tenant_id()::text as tenant`,
      );
      return result.rows[0]?.tenant;
    });
    expect(inside).toBe(tenantId);

    const after = await db.execute<{ tenant: string | null }>(
      sql`select app_current_tenant_id()::text as tenant`,
    );
    expect(after.rows[0]?.tenant).toBeNull();
  });
});
