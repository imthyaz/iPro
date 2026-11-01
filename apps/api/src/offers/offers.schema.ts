import {
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenantColumns } from '../db/columns.js';
import { appUsers } from '../identity/identity.schema.js';
import { letters } from '../letters/letters.schema.js';
import { engagements, persons } from '../people/people.schema.js';
import { workflowInstances } from '../workflow/workflow.schema.js';

// Kept in step with @ipro/shared (drizzle-kit can't import it); a unit test checks they match.
export const offerStatuses = [
  'draft',
  'pending_approval',
  'offered',
  'accepted',
  'joined',
  'declined',
  'withdrawn',
  'no_show',
] as const;
export const bandChecks = ['within', 'above', 'no_band', 'not_comparable'] as const;
export const guestStatuses = ['invited', 'failed', 'retired'] as const;

/**
 * An offer and where it is between draft and joining (spec workflow 1; decision #54). The person,
 * engagement, planned assignment and pay live in their own tables from the draft onwards.
 */
export const offers = pgTable(
  'offer',
  {
    ...tenantColumns(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    status: text('status', { enum: offerStatuses }).notNull(),
    /** Pay against the grade band, judged when the offer is made (pay is stored encrypted). */
    bandCheck: text('band_check', { enum: bandChecks }).notNull(),
    letterTemplateKey: text('letter_template_key').notNull(),
    extra: jsonb('extra').$type<Record<string, string>>().notNull().default({}),
    letterId: uuid('letter_id').references(() => letters.id),
    approvalRequestId: uuid('approval_request_id').references(() => workflowInstances.id),
    offeredAt: timestamp('offered_at', { withTimezone: true }),
    expiresOn: date('expires_on'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closeReason: text('close_reason'),
    /** Pre-joiner sign-in (decision #55): invited, failed (retried), or retired on joining or closing. */
    guestStatus: text('guest_status', { enum: guestStatuses }),
    /** The guest's Entra object id; their sign-in is linked to this person by it. */
    guestObjectId: text('guest_object_id'),
    /** The iPro user the guest signs in as, once known (locally, the dev user made for them). */
    guestUserId: uuid('guest_user_id').references(() => appUsers.id),
    guestInvitedAt: timestamp('guest_invited_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('offer_engagement_key').on(t.tenantId, t.engagementId),
    index('offer_status_idx').on(t.tenantId, t.status),
    index('offer_letter_idx').on(t.letterId),
  ],
);
