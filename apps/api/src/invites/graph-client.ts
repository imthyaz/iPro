/**
 * A small Microsoft Graph v1.0 client with application (client credentials) sign-in, shared by the
 * guest invitations (decision #55) and account disabling at exit (decision #82). No SDK: two
 * endpoints and a token are all iPro needs.
 */
export interface GraphClientOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

export const GRAPH = 'https://graph.microsoft.com/v1.0';

export class GraphClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly http: typeof fetch;

  constructor(private readonly options: GraphClientOptions) {
    this.http = options.fetch ?? fetch;
  }

  async request<T>(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<T> {
    const response = await this.http(`${GRAPH}${path}`, {
      method,
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

/** Graph's error text can name a person or email, so it stays out of the message (no PII in logs). */
export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(`Microsoft Graph request failed (${status} ${code})`);
  }
}
