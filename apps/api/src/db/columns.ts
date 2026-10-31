import { timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Columns every table carries (CLAUDE.md). `created_by`/`updated_by` are null only for system writes
 * (jobs, migrations, seed); they reference users once identity lands in slice 1.
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
