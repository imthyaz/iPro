import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { persons } from './people.schema.js';

export const documentTypes = ['kyc_scan', 'letter', 'certificate', 'photo', 'other'] as const;
export const kycTypes = ['pan', 'aadhaar', 'passport', 'bank', 'uan', 'esic'] as const;

/** Files kept in object storage; the row holds metadata only. A new version is a new row. */
export const documents = pgTable(
  'document',
  {
    ...tenantColumns(),
    ...softDeleteColumns(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    /** Set when the document belongs to a journey event (letters, slice 3). */
    journalEventId: uuid('journal_event_id'),
    type: text('type', { enum: documentTypes }).notNull(),
    title: text('title').notNull(),
    storageKey: text('storage_key').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    version: integer('version').notNull().default(1),
    previousVersionId: uuid('previous_version_id'),
    /** Letter templates arrive in slice 3. */
    generatedFromTemplateId: uuid('generated_from_template_id'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    /** Managers read only non-confidential team documents. */
    confidential: boolean('confidential').notNull().default(true),
  },
  (t) => [index('document_person_idx').on(t.personId)],
);

/** KYC identifiers, field-encrypted. One current record per person and type; replaced ones are soft-deleted. */
export const kycRecords = pgTable(
  'kyc_record',
  {
    ...tenantColumns(),
    ...softDeleteColumns(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    type: text('type', { enum: kycTypes }).notNull(),
    valueEncrypted: text('value_encrypted').notNull(),
    /** Non-secret extras, e.g. a bank's IFSC. */
    extra: jsonb('extra').$type<Record<string, string>>().notNull().default({}),
    documentId: uuid('document_id').references(() => documents.id),
    verifiedBy: uuid('verified_by'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('kyc_record_current_key')
      .on(t.tenantId, t.personId, t.type)
      .where(sql`${t.deletedAt} is null`),
  ],
);
