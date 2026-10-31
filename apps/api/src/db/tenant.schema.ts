import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The tenant is the root of everything, so it is the one table without `tenant_id`. Every other table
 * carries `tenant_id` and a row-level security policy on `app_current_tenant_id()` (see migration 0001).
 */
export const tenants = pgTable('tenant', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  name: text('name').notNull(),
  plan: text('plan').notNull().default('standard'),
  settings: jsonb('settings').notNull().default({}),
});
