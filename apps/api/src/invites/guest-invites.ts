import { randomUUID } from 'node:crypto';

export const GUEST_INVITES = Symbol('GUEST_INVITES');

export interface GuestInvite {
  email: string;
  displayName: string;
}

/**
 * Pre-joiner access (decision #55): the joiner's personal email is invited to Ideassion's Entra tenant
 * as a guest and added to the pre-joiners group, which maps to the employee role. Sign-in stays Entra.
 */
export interface GuestInvites {
  readonly name: 'fake' | 'graph';
  /** Returns the guest's Entra object id (the `oid` they sign in with). */
  invite(invite: GuestInvite): Promise<{ objectId: string }>;
}

/** Locally and in tests: records invitations; the offers module makes a dev sign-in user instead. */
export class FakeGuestInvites implements GuestInvites {
  readonly name = 'fake' as const;
  readonly sent: (GuestInvite & { objectId: string })[] = [];
  /** Test helper: the next invitation fails, as Graph might. */
  failNext = false;

  async invite(invite: GuestInvite): Promise<{ objectId: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Invitation failed (fake)');
    }
    const objectId = randomUUID();
    this.sent.push({ ...invite, objectId });
    return { objectId };
  }
}

export interface GraphGuestInvitesOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  groupId: string;
  redirectUrl: string;
  fetch?: typeof fetch;
}

const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Microsoft Graph invitations (application permissions User.Invite.All and GroupMember.ReadWrite.All,
 * granted by the account owner). Microsoft emails the invitation; the guest redeems it with a one-time
 * code. Built against Graph v1.0; verified with simulated responses until the tenant is set up.
 */
export class GraphGuestInvites implements GuestInvites {
  readonly name = 'graph' as const;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly http: typeof fetch;

  constructor(private readonly options: GraphGuestInvitesOptions) {
    this.http = options.fetch ?? fetch;
  }

  async invite(invite: GuestInvite): Promise<{ objectId: string }> {
    const created = await this.call<{ invitedUser: { id: string } }>('/invitations', {
      invitedUserEmailAddress: invite.email,
      invitedUserDisplayName: invite.displayName,
      inviteRedirectUrl: this.options.redirectUrl,
      sendInvitationMessage: true,
    });
    const objectId = created.invitedUser.id;
    try {
      await this.call(`/groups/${this.options.groupId}/members/$ref`, {
        '@odata.id': `${GRAPH}/directoryObjects/${objectId}`,
      });
    } catch (error) {
      // Inviting again (a retry) finds them already in the group, which is fine.
      const already =
        error instanceof GraphError && error.status === 400 && /already exist/i.test(error.detail);
      if (!already) throw error;
    }
    return { objectId };
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    const response = await this.http(`${GRAPH}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const parsed = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      throw new GraphError(
        response.status,
        parsed?.error?.code ?? '',
        parsed?.error?.message ?? '',
      );
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const response = await this.http(
      `https://login.microsoftonline.com/${this.options.tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          scope: 'https://graph.microsoft.com/.default',
        }),
      },
    );
    if (!response.ok) throw new GraphError(response.status, 'token', '');
    const token = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
    return token.access_token;
  }
}

/** Graph's error text can name the invited email, so it stays out of the message (CLAUDE.md: no PII in logs). */
export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(`Microsoft Graph request failed (${status} ${code})`);
  }
}
