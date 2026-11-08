import { randomUUID } from 'node:crypto';
import { GRAPH, GraphClient, GraphError } from './graph-client.js';

export { GraphError };

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

/**
 * Microsoft Graph invitations (application permissions User.Invite.All and GroupMember.ReadWrite.All,
 * granted by the account owner). Microsoft emails the invitation; the guest redeems it with a one-time
 * code. Built against Graph v1.0; verified with simulated responses until the tenant is set up.
 */
export class GraphGuestInvites implements GuestInvites {
  readonly name = 'graph' as const;
  private readonly graph: GraphClient;

  constructor(private readonly options: GraphGuestInvitesOptions) {
    this.graph = new GraphClient(options);
  }

  async invite(invite: GuestInvite): Promise<{ objectId: string }> {
    const created = await this.graph.request<{ invitedUser: { id: string } }>(
      'POST',
      '/invitations',
      {
        invitedUserEmailAddress: invite.email,
        invitedUserDisplayName: invite.displayName,
        inviteRedirectUrl: this.options.redirectUrl,
        sendInvitationMessage: true,
      },
    );
    const objectId = created.invitedUser.id;
    try {
      await this.graph.request('POST', `/groups/${this.options.groupId}/members/$ref`, {
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
}
