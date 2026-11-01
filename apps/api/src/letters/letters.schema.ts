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
import { tenantColumns } from '../db/columns.js';
import { documents } from '../people/documents.schema.js';
import { engagements, persons } from '../people/people.schema.js';

export const letterTypes = [
  'offer',
  'loi',
  'confirmation',
  'extension',
  'transfer',
  'relieving',
  'experience',
  'termination',
  'other',
] as const;

/** Letter template (spec: LetterTemplate): versioned like checklists and workflows. */
export const letterTemplates = pgTable(
  'letter_template',
  {
    ...tenantColumns(),
    key: text('key').notNull(),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    type: text('type', { enum: letterTypes }).notNull(),
    body: text('body').notNull(),
    approverRole: text('approver_role', { enum: ['hr', 'hr_head'] }),
    signature: text('signature', { enum: ['none', 'employee'] }).notNull(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('letter_template_version_key').on(t.tenantId, t.key, t.version)],
);

export const letterStatuses = [
  'pending_approval',
  'ready',
  'sent',
  'signed',
  'declined',
  'returned',
  'cancelled',
] as const;

/** One generated letter and where it is in approval and signing. The PDF itself is a Document. */
export const letters = pgTable(
  'letter',
  {
    ...tenantColumns(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    templateId: uuid('template_id')
      .notNull()
      .references(() => letterTemplates.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    status: text('status', { enum: letterStatuses }).notNull(),
    /** Values given for {{extra.*}} fields. */
    extra: jsonb('extra').$type<Record<string, string>>().notNull().default({}),
    approvalRequestId: uuid('approval_request_id'),
    esignProvider: text('esign_provider'),
    esignRequestId: text('esign_request_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    signedDocumentId: uuid('signed_document_id').references(() => documents.id),
  },
  (t) => [
    index('letter_person_idx').on(t.personId),
    uniqueIndex('letter_esign_request_key').on(t.tenantId, t.esignRequestId),
  ],
);
