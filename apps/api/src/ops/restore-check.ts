import pg from 'pg';

/**
 * Restore verification (slice 14c; decision #98). Before a restore, take a manifest of the source
 * database: for every tenant and every tenant table, how many rows were created up to a cut-off and
 * a hash of their ids, plus the applied migrations. After the restore, take the same manifest of the
 * restored database and compare. Ids, counts and hashes only: no personal data leaves the database.
 *
 * Rows are read as the app role with the tenant set, so row-level security applies exactly as it
 * does for the app (and no superuser is needed on RDS).
 */
export interface TableFingerprint {
  rows: number;
  /** md5 of the ids, in order, of rows created at or before the cut-off. */
  idsHash: string;
}

export interface RestoreManifest {
  /** Rows created at or before this instant are compared; later rows are ignored. */
  cutoff: string;
  takenAt: string;
  /** Applied migrations, oldest first (drizzle's hashes). */
  migrations: string[];
  /** tenant id → table → fingerprint. */
  tenants: Record<string, Record<string, TableFingerprint>>;
}

const APP_ROLE = 'ipro_app';

/** Tenant tables with the columns the comparison needs. Counters without created_at are skipped. */
async function tenantTables(client: pg.ClientBase): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `select c.table_name
       from information_schema.columns c
      where c.table_schema = 'public' and c.column_name in ('tenant_id', 'created_at', 'id')
      group by c.table_name
     having count(*) = 3
      order by c.table_name`,
  );
  return rows.map((r) => r.table_name);
}

export async function takeManifest(
  connectionString: string,
  cutoff: Date,
  now = new Date(),
): Promise<RestoreManifest> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const migrations = (
      await client.query<{ hash: string }>(
        'select hash from drizzle.__drizzle_migrations order by created_at, id',
      )
    ).rows.map((r) => r.hash);
    const tables = await tenantTables(client);
    const tenantIds = (
      await client.query<{ id: string }>('select id from tenant order by id')
    ).rows.map((r) => r.id);
    const tenants: RestoreManifest['tenants'] = {};
    for (const tenantId of tenantIds) {
      await client.query('begin read only');
      try {
        await client.query(`set local role ${APP_ROLE}`);
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
        const fingerprints: Record<string, TableFingerprint> = {};
        for (const table of tables) {
          const { rows } = await client.query<{ rows: number; ids_hash: string | null }>(
            `select count(*)::int as rows, md5(string_agg(id::text, ',' order by id)) as ids_hash
               from "${table}" where created_at <= $1`,
            [cutoff],
          );
          if (rows[0]!.rows > 0) {
            fingerprints[table] = { rows: rows[0]!.rows, idsHash: rows[0]!.ids_hash! };
          }
        }
        tenants[tenantId] = fingerprints;
      } finally {
        await client.query('rollback');
      }
    }
    return { cutoff: cutoff.toISOString(), takenAt: now.toISOString(), migrations, tenants };
  } finally {
    await client.end();
  }
}

/** What differs between the source manifest and the restored one; empty when the restore is good. */
export function compareManifests(source: RestoreManifest, restored: RestoreManifest): string[] {
  const problems: string[] = [];
  if (source.cutoff !== restored.cutoff) {
    problems.push(`Cut-offs differ: ${source.cutoff} and ${restored.cutoff}`);
  }
  const missingMigrations = source.migrations.filter((m) => !restored.migrations.includes(m));
  if (missingMigrations.length > 0) {
    problems.push(`${missingMigrations.length} migration(s) missing from the restored database`);
  }
  for (const [tenantId, tables] of Object.entries(source.tenants)) {
    const other = restored.tenants[tenantId];
    if (!other) {
      problems.push(`Tenant ${tenantId} is missing`);
      continue;
    }
    for (const [table, want] of Object.entries(tables)) {
      const got = other[table];
      if (!got) problems.push(`Tenant ${tenantId}: ${table} has no rows (expected ${want.rows})`);
      else if (got.rows !== want.rows) {
        problems.push(`Tenant ${tenantId}: ${table} has ${got.rows} rows (expected ${want.rows})`);
      } else if (got.idsHash !== want.idsHash) {
        problems.push(`Tenant ${tenantId}: ${table} has the same count but different rows`);
      }
    }
    for (const table of Object.keys(other)) {
      if (!tables[table]) problems.push(`Tenant ${tenantId}: ${table} has rows the source didn't`);
    }
  }
  for (const tenantId of Object.keys(restored.tenants)) {
    if (!source.tenants[tenantId]) problems.push(`Tenant ${tenantId} wasn't in the source`);
  }
  return problems;
}
