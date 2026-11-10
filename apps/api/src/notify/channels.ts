import { GraphClient, GraphError } from '../invites/graph-client.js';
import type { AdaptiveCard } from './teams-cards.js';

/**
 * Delivery channels (decision #87): Teams through our bot (Bot Connector REST, no SDK) and email
 * through Microsoft Graph from iPro's no-reply mailbox. "fake" records what would be sent (local and
 * tests); "none" means the channel isn't set up yet, so everything falls back to the other one.
 */
export const TEAMS_CHANNEL = Symbol('TEAMS_CHANNEL');
export const MAIL_CHANNEL = Symbol('MAIL_CHANNEL');

/** Where the bot reaches one person: saved when the iPro app is installed for them. */
export interface TeamsAddress {
  serviceUrl: string;
  conversationId: string;
}

/** A permanent failure: retrying won't help (e.g. the person removed the app). */
export class Unreachable extends Error {}

export interface TeamsChannel {
  readonly name: 'fake' | 'bot' | 'none';
  send(to: TeamsAddress, card: AdaptiveCard): Promise<void>;
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
}

export interface MailChannel {
  readonly name: 'fake' | 'graph' | 'none';
  send(message: MailMessage): Promise<void>;
}

export class FakeTeams implements TeamsChannel {
  readonly name = 'fake' as const;
  readonly sent: { to: TeamsAddress; card: AdaptiveCard }[] = [];
  /** Test helpers: the next send fails, for a while or for good. */
  failNext: 'transient' | 'unreachable' | null = null;

  async send(to: TeamsAddress, card: AdaptiveCard): Promise<void> {
    const failure = this.failNext;
    this.failNext = null;
    if (failure === 'unreachable') throw new Unreachable('Not reachable in Teams (fake)');
    if (failure === 'transient') throw new Error('Teams is busy (fake)');
    this.sent.push({ to, card });
  }
}

export class NoTeams implements TeamsChannel {
  readonly name = 'none' as const;
  async send(): Promise<void> {
    throw new Unreachable('Teams is not set up');
  }
}

export interface BotTeamsOptions {
  appId: string;
  appSecret: string;
  /** Ideassion's Entra tenant: the bot is single-tenant. */
  tenantId: string;
  fetch?: typeof fetch;
}

/** Proactive messages through the Bot Connector service (bot app id and secret from Azure Bot). */
export class BotTeams implements TeamsChannel {
  readonly name = 'bot' as const;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly http: typeof fetch;

  constructor(private readonly options: BotTeamsOptions) {
    this.http = options.fetch ?? fetch;
  }

  async send(to: TeamsAddress, card: AdaptiveCard): Promise<void> {
    const base = to.serviceUrl.replace(/\/$/, '');
    const response = await this.http(
      `${base}/v3/conversations/${encodeURIComponent(to.conversationId)}/activities`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'message',
          attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
        }),
      },
    );
    // 403/404: the app was removed or the conversation is gone. Retrying won't help.
    if (response.status === 403 || response.status === 404) {
      throw new Unreachable(`Teams conversation unavailable (${response.status})`);
    }
    if (!response.ok) throw new Error(`Teams send failed (${response.status})`);
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
          client_id: this.options.appId,
          client_secret: this.options.appSecret,
          scope: 'https://api.botframework.com/.default',
        }),
      },
    );
    if (!response.ok) throw new Error(`Bot token request failed (${response.status})`);
    const token = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
    return token.access_token;
  }
}

export class FakeMail implements MailChannel {
  readonly name = 'fake' as const;
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

export class NoMail implements MailChannel {
  readonly name = 'none' as const;
  async send(): Promise<void> {
    throw new Unreachable('Email is not set up');
  }
}

export interface GraphMailOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The no-reply mailbox iPro sends from; IT limits Mail.Send to it (application access policy). */
  from: string;
  fetch?: typeof fetch;
}

/** Email through Graph sendMail, not saved to Sent Items. */
export class GraphMail implements MailChannel {
  readonly name = 'graph' as const;
  private readonly graph: GraphClient;

  constructor(private readonly options: GraphMailOptions) {
    this.graph = new GraphClient(options);
  }

  async send(message: MailMessage): Promise<void> {
    try {
      await this.graph.request('POST', `/users/${encodeURIComponent(this.options.from)}/sendMail`, {
        message: {
          subject: message.subject,
          body: { contentType: 'HTML', content: message.html },
          toRecipients: [{ emailAddress: { address: message.to } }],
        },
        saveToSentItems: false,
      });
    } catch (error) {
      // A bad address is permanent; anything else may pass on a retry.
      if (error instanceof GraphError && (error.status === 400 || error.status === 404)) {
        throw new Unreachable(error.message);
      }
      throw error;
    }
  }
}
