import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { softDeleteColumns, tenantColumns } from '../db/columns.js';
import { appUsers } from '../identity/identity.schema.js';
import { persons } from '../people/people.schema.js';

/** A company policy (handbook, leave policy, code of conduct…) and who it applies to. */
export const policies = pgTable(
  'policy',
  {
    ...tenantColumns(),
    ...softDeleteColumns(),
    code: text('code').notNull(),
    title: text('title').notNull(),
    /** Same filter as checklists: legal entities, engagement types, departments, locations. */
    appliesTo: jsonb('applies_to').$type<Record<string, unknown>>().notNull(),
    requiresAcknowledgement: boolean('requires_acknowledgement').notNull().default(true),
  },
  (t) => [uniqueIndex('policy_code_key').on(t.tenantId, t.code)],
);

/**
 * A published version of a policy (spec: PolicyDocument). The file lives in object storage; the
 * SHA-256 of its bytes is what people acknowledge. Search chunks for Ask iPro come in slice 12.
 */
export const policyVersions = pgTable(
  'policy_version',
  {
    ...tenantColumns(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => policies.id),
    version: integer('version').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    summary: text('summary'),
    storageKey: text('storage_key').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    contentHash: text('content_hash').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('policy_version_key').on(t.policyId, t.version)],
);

/**
 * An in-app acceptance (spec: PolicyAcknowledgement): who accepted which version, the content hash
 * they saw, when, and from which session and device. Never edited.
 */
export const policyAcknowledgements = pgTable(
  'policy_acknowledgement',
  {
    ...tenantColumns(),
    policyVersionId: uuid('policy_version_id')
      .notNull()
      .references(() => policyVersions.id),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id),
    contentHash: text('content_hash').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
    sessionId: uuid('session_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    uniqueIndex('policy_acknowledgement_once_key').on(t.policyVersionId, t.personId),
    index('policy_acknowledgement_person_idx').on(t.personId),
  ],
);
