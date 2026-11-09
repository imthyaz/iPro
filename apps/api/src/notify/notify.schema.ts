import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenantColumns } from '../db/columns.js';
import { appUsers } from '../identity/identity.schema.js';
import { notifications } from '../workflow/workflow.schema.js';

/**
 * The outbox Teams and email deliver from (decision #87): one row per notification and channel. A
 * job sends due rows; failures retry with a back-off; a Teams row that can't reach the person is
 * marked unreachable and an email row takes its place. Rows are kept as the delivery record.
 */
export const notificationDeliveries = pgTable(
  'notification_delivery',
  {
    ...tenantColumns(),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => appUsers.id),
    channel: text('channel', { enum: ['teams', 'email'] }).notNull(),
    status: text('status', { enum: ['pending', 'sent', 'failed', 'unreachable'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    /** A short reason with no personal data (e.g. "Teams send failed (503)"). */
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    index('notification_delivery_due_idx').on(t.status, t.nextAttemptAt),
    uniqueIndex('notification_delivery_once_key').on(t.tenantId, t.notificationId, t.channel),
  ],
);

/**
 * Where the iPro bot reaches each person in Teams, saved when the app is installed for them (Teams
 * sends the bot an installation event). Without a row, Teams can't reach the person: email instead.
 */
export const teamsConversations = pgTable(
  'teams_conversation',
  {
    ...tenantColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id),
    serviceUrl: text('service_url').notNull(),
    conversationId: text('conversation_id').notNull(),
    /** Set when the app is removed; the row stays as the record. */
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('teams_conversation_user_key').on(t.tenantId, t.userId)],
);
