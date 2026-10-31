import { boolean, date, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenantColumns } from '../db/columns.js';

export const eventSensitivities = ['public', 'manager', 'hr', 'restricted'] as const;

/**
 * The journey: every workflow's final transition writes one event; timelines read only from here.
 * Append-only: the app may insert, and may only flip `is_planned` when a planned event happens.
 */
export const journalEvents = pgTable(
  'journal_event',
  {
    ...tenantColumns(),
    engagementId: uuid('engagement_id').notNull(),
    /** Timelines are per person across engagements (decision #19). */
    personId: uuid('person_id').notNull(),
    eventType: text('event_type').notNull(),
    category: text('category').notNull(),
    occurredOn: date('occurred_on').notNull(),
    isPlanned: boolean('is_planned').notNull().default(false),
    title: text('title').notNull(),
    detailJson: jsonb('detail_json').$type<Record<string, unknown>>().notNull().default({}),
    sensitivity: text('sensitivity', { enum: eventSensitivities }).notNull(),
    sourceTable: text('source_table').notNull(),
    sourceId: uuid('source_id').notNull(),
    /** Back-filled from history by the import (slice 13). */
    migrated: boolean('migrated').notNull().default(false),
  },
  (t) => [
    index('journal_event_person_idx').on(t.personId, t.occurredOn),
    // "No event is written twice."
    uniqueIndex('journal_event_source_key').on(t.tenantId, t.sourceTable, t.sourceId, t.eventType),
  ],
);
