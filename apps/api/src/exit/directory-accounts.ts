import { GraphClient, type GraphClientOptions } from '../invites/graph-client.js';

export const DIRECTORY_ACCOUNTS = Symbol('DIRECTORY_ACCOUNTS');

/**
 * Ending a leaver's Microsoft Entra account at the end of their last working day (spec: SSO disable
 * on exit; decision #82). "none" until IT grants the Graph permission: iPro then raises an IT task.
 */
export interface DirectoryAccounts {
  readonly name: 'fake' | 'graph' | 'none';
  /** Disables the account and ends its sign-in sessions. Throws when it can't. */
  disable(objectId: string): Promise<void>;
}

/** Locally and in tests: records the accounts disabled. */
export class FakeDirectoryAccounts implements DirectoryAccounts {
  readonly name = 'fake' as const;
  readonly disabled: string[] = [];
  async disable(objectId: string): Promise<void> {
    this.disabled.push(objectId);
  }
}

/** Not set up yet: every exit goes to IT as a task. */
export class NoDirectoryAccounts implements DirectoryAccounts {
  readonly name = 'none' as const;
  async disable(): Promise<void> {
    throw new Error('Directory account disabling is not set up');
  }
}

/**
 * Microsoft Graph (application permissions User.EnableDisableAccount.All and
 * User.RevokeSessions.All, granted by IT): accountEnabled false, then sign-in sessions revoked.
 * Built against Graph v1.0; verified with simulated responses until the tenant is set up.
 */
export class GraphDirectoryAccounts implements DirectoryAccounts {
  readonly name = 'graph' as const;
  private readonly graph: GraphClient;

  constructor(options: GraphClientOptions) {
    this.graph = new GraphClient(options);
  }

  async disable(objectId: string): Promise<void> {
    const id = encodeURIComponent(objectId);
    await this.graph.request('PATCH', `/users/${id}`, { accountEnabled: false });
    await this.graph.request('POST', `/users/${id}/revokeSignInSessions`, {});
  }
}
