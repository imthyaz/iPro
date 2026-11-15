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
    /**
     * Ask iPro's reading of the file (decision #89): pending until read; ready with clauses; empty
     * when the file has no text (a scanned PDF); failed when it couldn't be read.
     */
    textStatus: text('text_status', { enum: ['pending', 'ready', 'empty', 'failed'] })
      .notNull()
      .default('pending'),
    clauseCount: integer('clause_count').notNull().default(0),
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

/**
 * A clause of a published policy version, as Ask iPro searches it (spec: PolicyDocument chunks for
 * search; decision #89). Rebuilt only when a new version is published; a full-text index (added in
 * the migration) makes it searchable.
 */
export const policyClauses = pgTable(
  'policy_clause',
  {
    ...tenantColumns(),
    policyVersionId: uuid('policy_version_id')
      .notNull()
      .references(() => policyVersions.id),
    /** Order in the document, from 1; links point here (?clause=N). */
    position: integer('position').notNull(),
    /** The document's own number ("4.2"), when it has one. */
    number: text('number'),
    heading: text('heading').notNull(),
    body: text('body').notNull(),
  },
  (t) => [uniqueIndex('policy_clause_position_key').on(t.policyVersionId, t.position)],
);
