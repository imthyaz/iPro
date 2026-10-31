import { sql } from 'drizzle-orm';
import {
  date,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { softDeleteColumns, tenantColumns } from '../db/columns.js';

// drizzle-kit loads schema files as CommonJS and can't import the ESM shared package, so the values are
// repeated here; identity.schema.test.ts keeps them equal to `roles` in @ipro/shared.
export const roleValues = ['employee', 'manager', 'hr', 'hr_head', 'cxo', 'admin'] as const;
export const roleEnum = pgEnum('role', roleValues);

/** A person who can sign in. Linked to their Person record from slice 2. */
export const appUsers = pgTable(
  'app_user',
  {
    ...tenantColumns(),
    /** Entra object id (`oid` claim); null for synthetic dev users. */
    entraObjectId: text('entra_object_id'),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    personId: uuid('person_id'),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('app_user_entra_object_id_key')
      .on(t.tenantId, t.entraObjectId)
      .where(sql`${t.entraObjectId} is not null`),
  ],
);

/** Roles a user holds. Rows from Entra groups are re-synced at every sign-in; manual rows are kept. */
export const roleAssignments = pgTable(
  'role_assignment',
  {
    ...tenantColumns(),
    ...softDeleteColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id),
    role: roleEnum('role').notNull(),
    /** null = every legal entity. */
    legalEntityId: uuid('legal_entity_id'),
    source: text('source', { enum: ['entra_group', 'manual'] }).notNull(),
  },
  (t) => [index('role_assignment_user_idx').on(t.userId)],
);

/** Admin-configured mapping of Entra security groups to iPro roles (screen A4). */
export const entraGroupRoles = pgTable(
  'entra_group_role',
  {
    ...tenantColumns(),
    ...softDeleteColumns(),
    entraGroupId: text('entra_group_id').notNull(),
    role: roleEnum('role').notNull(),
    legalEntityId: uuid('legal_entity_id'),
  },
  (t) => [index('entra_group_role_group_idx').on(t.entraGroupId)],
);

/** Server-side sessions. Only a SHA-256 hash of the cookie token is stored. */
export const sessions = pgTable(
  'session',
  {
    ...tenantColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id),
    tokenHash: text('token_hash').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [uniqueIndex('session_token_hash_key').on(t.tokenHash)],
);

/** In-flight Entra sign-ins: PKCE verifier and nonce, keyed by the OIDC `state`. Live for 10 minutes. */
export const authRequests = pgTable(
  'auth_request',
  {
    ...tenantColumns(),
    state: text('state').notNull(),
    codeVerifier: text('code_verifier').notNull(),
    nonce: text('nonce').notNull(),
    returnTo: text('return_to').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('auth_request_state_key').on(t.state)],
);

/** A manager's approvals handed to another manager for a date range (applied by workflows, slice 3). */
export const approvalDelegations = pgTable(
  'approval_delegation',
  {
    ...tenantColumns(),
    delegatorUserId: uuid('delegator_user_id')
      .notNull()
      .references(() => appUsers.id),
    delegateUserId: uuid('delegate_user_id')
      .notNull()
      .references(() => appUsers.id),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    reason: text('reason'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
  },
  (t) => [index('approval_delegation_delegator_idx').on(t.delegatorUserId)],
);
