import { sql } from 'drizzle-orm';
import type { Db } from './db.module.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Runs `fn` in a transaction with `app.tenant_id` set for that transaction only (SET LOCAL semantics),
 * which is what the tenant row-level security policies read.
 */
export function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
