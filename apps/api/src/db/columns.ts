import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenant.schema.js';

/**
 * Columns every table carries (CLAUDE.md). `created_by`/`updated_by` are null only for system writes
 * (jobs, migrations, seed).
 */
export function auditColumns() {
  return {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  };
}

/**
 * Audit columns plus `tenant_id`. Every table built with this needs the row-level security block from
 * migration 0001's header (see 0002 for examples).
 */
export function tenantColumns() {
  return {
    ...auditColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
  };
}

/** Soft delete (nothing is hard-deleted except by the retention job). */
export function softDeleteColumns() {
  return {
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by'),
  };
}
