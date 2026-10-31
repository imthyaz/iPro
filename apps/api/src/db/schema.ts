import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { auditColumns } from './columns.js';

/**
 * The tenant is the root of everything, so it is the one table without `tenant_id`. Every other table
 * carries `tenant_id` and a row-level security policy on `app_current_tenant_id()` (see migration 0001).
 */
export const tenants = pgTable('tenant', {
  ...auditColumns(),
  name: text('name').notNull(),
  plan: text('plan').notNull().default('standard'),
  settings: jsonb('settings').notNull().default({}),
});
