import { customType, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenantColumns } from '../db/columns.js';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const auditActions = ['view', 'unmask', 'create', 'update', 'delete', 'export'] as const;
export type AuditAction = (typeof auditActions)[number];

/** Field-level change: names and, for non-sensitive fields only, before/after values. */
export type FieldChange = { field: string; from?: unknown; to?: unknown; sensitive?: boolean };

/** Append-only (a trigger rejects update and delete). `created_by` is the actor. */
export const auditLog = pgTable(
  'audit_log',
  {
    ...tenantColumns(),
    action: text('action', { enum: auditActions }).notNull(),
    tableName: text('table_name').notNull(),
    recordId: uuid('record_id'),
    /** The person the data is about, so HR can see who looked at whose record (screen A7). */
    subjectPersonId: uuid('subject_person_id'),
    fieldChanges: jsonb('field_changes').$type<FieldChange[]>(),
    requestId: uuid('request_id'),
    ip: text('ip'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_record_idx').on(t.tableName, t.recordId),
    index('audit_log_actor_idx').on(t.createdBy, t.at),
  ],
);

/** Each tenant's field-encryption data key, wrapped by KMS. Plaintext keys never touch the database. */
export const tenantDataKeys = pgTable('tenant_data_key', {
  ...tenantColumns(),
  provider: text('provider', { enum: ['kms', 'local'] }).notNull(),
  keyRef: text('key_ref').notNull(),
  wrappedKey: bytea('wrapped_key').notNull(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
});
