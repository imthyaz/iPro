import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { AssistantActionView, AssistantOpen, AssistantSource } from '@ipro/shared';
import { tenantColumns } from '../db/columns.js';
import { appUsers } from '../identity/identity.schema.js';

/**
 * Ask iPro conversations (spec: AssistantConversation). Each belongs to one user and only they read
 * it. Kept 180 days, then replaced by an archived summary (slice 12c).
 */
export const assistantConversations = pgTable(
  'assistant_conversation',
  {
    ...tenantColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id),
    title: text('title').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp('last_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('assistant_conversation_user_idx').on(t.userId, t.lastAt)],
);

/** One tool call of an answer: which tool, with what input, and whether it ran (no results kept). */
export interface ToolCallRecord {
  tool: string;
  input: Record<string, unknown>;
  outcome: 'ok' | 'refused' | 'error';
}

/** A record an answer referred to, for the archived summary's links. */
export interface LinkedRecord {
  type: 'person' | 'leave_balance' | 'policy' | 'approval' | 'screen';
  id: string;
}

/** A question or an answer (spec: AssistantMessage). Never edited. */
export const assistantMessages = pgTable(
  'assistant_message',
  {
    ...tenantColumns(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversations.id),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    text: text('text').notNull(),
    toolCalls: jsonb('tool_calls').$type<ToolCallRecord[]>().notNull().default([]),
    sources: jsonb('sources').$type<AssistantSource[]>().notNull().default([]),
    open: jsonb('open').$type<AssistantOpen | null>(),
    linkedRecords: jsonb('linked_records').$type<LinkedRecord[]>().notNull().default([]),
    /** The model tier that answered (lookup or reasoning); null for questions. */
    model: text('model'),
    /** The confirmation card this answer offered (decision #91). */
    proposedActionId: uuid('proposed_action_id'),
    /** Set when that card was confirmed (spec: confirmed_action_id). */
    confirmedActionId: uuid('confirmed_action_id'),
  },
  (t) => [index('assistant_message_conversation_idx').on(t.conversationId, t.createdAt)],
);

/**
 * A change Ask iPro prepared (decision #91): the exact effect shown on a card, and the request that
 * confirming makes. Nothing happens until its user confirms it, within 30 minutes; it then runs
 * through the same service and permission checks as the screen it stands for, as that user.
 */
export const assistantActions = pgTable(
  'assistant_action',
  {
    ...tenantColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversations.id),
    kind: text('kind', { enum: ['apply_leave', 'approve_leave', 'draft_letter'] }).notNull(),
    /** The request confirming makes (e.g. the leave application), checked again on confirm. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    card: jsonb('card')
      .$type<Pick<AssistantActionView, 'title' | 'lines' | 'confirmLabel'>>()
      .notNull(),
    status: text('status', {
      enum: ['proposed', 'confirming', 'confirmed', 'cancelled', 'failed'],
    })
      .notNull()
      .default('proposed'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    result: jsonb('result').$type<{ text: string; link: string | null } | null>(),
  },
  (t) => [index('assistant_action_user_idx').on(t.userId, t.createdAt)],
);
