import { Inject, Injectable } from '@nestjs/common';
import { requireContext } from '../context/request-context.js';
import { DB, type Db } from './tokens.js';
import { withTenant, type Tx } from './tenant-context.js';

/** The way modules reach the database: one transaction, scoped to the current request's tenant. */
@Injectable()
export class TenantDb {
  constructor(@Inject(DB) private readonly db: Db) {}

  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.db, requireContext().tenantId, fn);
  }
}
