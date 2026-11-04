import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable } from '@nestjs/common';
import { requireContext } from '../context/request-context.js';
import { DB, type Db } from './tokens.js';
import { withTenant, type Tx } from './tenant-context.js';

/** The transaction a call is already inside, if any (per async call chain). */
const ambient = new AsyncLocalStorage<{ tx: Tx; tenantId: string }>();

/**
 * The way modules reach the database: one transaction, scoped to the current request's tenant.
 * A call made inside another's transaction joins it, as a savepoint, rather than taking a second
 * connection: nested connections could starve the pool under load, and the inner work should see the
 * outer transaction's changes. The savepoint means an inner failure (or a deliberate trial-run rollback)
 * undoes only the inner work.
 */
@Injectable()
export class TenantDb {
  constructor(@Inject(DB) private readonly db: Db) {}

  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tenantId = requireContext().tenantId;
    const current = ambient.getStore();
    if (current && current.tenantId === tenantId) {
      return current.tx.transaction((savepoint) =>
        ambient.run({ tx: savepoint, tenantId }, () => fn(savepoint)),
      );
    }
    return withTenant(this.db, tenantId, (tx) => ambient.run({ tx, tenantId }, () => fn(tx)));
  }
}
