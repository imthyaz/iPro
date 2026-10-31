import { sql } from 'drizzle-orm';
import type { Db } from './tokens.js';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Non-owner role that row-level security applies to (decision #26). Created in migration 0002. */
export const APP_ROLE = 'ipro_app';

/**
 * Runs `fn` in a transaction as the `ipro_app` role with `app.tenant_id` set, both for that transaction
 * only (SET LOCAL semantics). The tenant row-level security policies read `app.tenant_id`.
 */
export function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
