import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import * as client from 'openid-client';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import {
  diffGrants,
  identityFromClaims,
  rolesFromGroups,
  SignInRejected,
  type EntraIdentity,
} from './entra/claims.js';
import { OIDC_PROVIDER, type OidcProvider } from './entra/oidc-provider.js';
import { appUsers, authRequests, entraGroupRoles, roleAssignments } from './identity.schema.js';
import { engagements } from '../people/people.schema.js';
import { safeReturnTo } from './session-token.js';

const SIGN_IN_WINDOW_MS = 10 * 60_000;

@Injectable()
export class SignInService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(OIDC_PROVIDER) private readonly oidc: OidcProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Step 1 of Entra sign-in: remember the PKCE verifier and nonce, return Entra's sign-in URL. */
  async beginEntra(returnTo: unknown, now = new Date()): Promise<URL> {
    const checks = {
      state: client.randomState(),
      nonce: client.randomNonce(),
      codeVerifier: client.randomPKCECodeVerifier(),
    };
    const { tenantId } = requireContext();
    await this.db.tx((tx) =>
      tx.insert(authRequests).values({
        tenantId,
        ...checks,
        returnTo: safeReturnTo(returnTo),
        expiresAt: new Date(now.getTime() + SIGN_IN_WINDOW_MS),
      }),
    );
    return this.oidc.authorizationUrl(checks);
  }

  /** Step 2: verify the callback, then create or update the user and re-sync roles from Entra groups. */
  async completeEntra(
    callbackUrl: URL,
    now = new Date(),
  ): Promise<{ userId: string; returnTo: string }> {
    const state = callbackUrl.searchParams.get('state');
    if (!state) throw new SignInRejected('Missing state');

    const request = await this.db.tx(async (tx) => {
      const [row] = await tx
        .update(authRequests)
        .set({ consumedAt: now })
        .where(
          and(
            eq(authRequests.state, state),
            isNull(authRequests.consumedAt),
            gt(authRequests.expiresAt, now),
          ),
        )
        .returning();
      return row;
    });
    if (!request) throw new SignInRejected('Sign-in expired or already used');

    const claims = await this.oidc.exchange(callbackUrl, request);
    const identity = identityFromClaims(claims, this.config.ENTRA_TENANT_ID ?? '');
    const userId = await this.db.tx((tx) => this.upsertEntraUser(tx, identity, now));
    return { userId, returnTo: request.returnTo };
  }

  /** Dev sign-in: any synthetic user (no Entra identity). Unavailable when Entra is configured. */
  async devSignIn(userId: string): Promise<string> {
    if (this.config.AUTH_MODE !== 'dev') throw new NotFoundException();
    const user = await this.db.tx(async (tx) => {
      const [row] = await tx
        .select({ id: appUsers.id, email: appUsers.email })
        .from(appUsers)
        .where(
          and(
            eq(appUsers.id, userId),
            isNull(appUsers.entraObjectId),
            eq(appUsers.status, 'active'),
          ),
        );
      if (row) await refreshPersonLink(tx, row.id, row.email);
      return row;
    });
    if (!user) throw new NotFoundException();
    return user.id;
  }

  private async upsertEntraUser(tx: Tx, identity: EntraIdentity, now: Date): Promise<string> {
    const { tenantId } = requireContext();
    const mappings = await tx
      .select({
        entraGroupId: entraGroupRoles.entraGroupId,
        role: entraGroupRoles.role,
        legalEntityId: entraGroupRoles.legalEntityId,
      })
      .from(entraGroupRoles)
      .where(isNull(entraGroupRoles.deletedAt));
    const wanted = rolesFromGroups(identity.groups, mappings);

    const [existing] = await tx
      .select({ id: appUsers.id, status: appUsers.status })
      .from(appUsers)
      .where(eq(appUsers.entraObjectId, identity.objectId));
    if (existing?.status === 'disabled') throw new SignInRejected('User is disabled');

    const manual = existing
      ? await tx
          .select({ id: roleAssignments.id })
          .from(roleAssignments)
          .where(
            and(
              eq(roleAssignments.userId, existing.id),
              eq(roleAssignments.source, 'manual'),
              isNull(roleAssignments.deletedAt),
            ),
          )
      : [];
    if (wanted.length === 0 && manual.length === 0) {
      throw new SignInRejected('No iPro role is mapped to any of the user’s Entra groups');
    }

    let userId: string;
    if (existing) {
      userId = existing.id;
      await tx
        .update(appUsers)
        .set({ email: identity.email, displayName: identity.displayName, updatedAt: now })
        .where(eq(appUsers.id, userId));
    } else {
      const [created] = await tx
        .insert(appUsers)
        .values({
          tenantId,
          entraObjectId: identity.objectId,
          email: identity.email,
          displayName: identity.displayName,
        })
        .returning({ id: appUsers.id });
      userId = created!.id;
    }

    const current = await tx
      .select({
        id: roleAssignments.id,
        role: roleAssignments.role,
        legalEntityId: roleAssignments.legalEntityId,
      })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.userId, userId),
          eq(roleAssignments.source, 'entra_group'),
          isNull(roleAssignments.deletedAt),
        ),
      );
    const { add, retireIds } = diffGrants(current, wanted);
    for (const id of retireIds) {
      await tx
        .update(roleAssignments)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(roleAssignments.id, id));
    }
    if (add.length > 0) {
      await tx
        .insert(roleAssignments)
        .values(
          add.map((grant) => ({ ...grant, tenantId, userId, source: 'entra_group' as const })),
        );
    }
    await refreshPersonLink(tx, userId, identity.email);
    return userId;
  }
}

/**
 * Points the user at the person whose current engagement has this work email (decision #34). Left
 * unchanged when no current engagement matches, so an exited person keeps their history link.
 */
async function refreshPersonLink(tx: Tx, userId: string, email: string): Promise<void> {
  const [match] = await tx
    .select({ personId: engagements.personId })
    .from(engagements)
    .where(
      and(
        sql`lower(${engagements.workEmail}) = lower(${email})`,
        inArray(engagements.status, ['offered', 'pre_joining', 'active', 'on_notice']),
      ),
    );
  if (match) {
    await tx.update(appUsers).set({ personId: match.personId }).where(eq(appUsers.id, userId));
  }
}
