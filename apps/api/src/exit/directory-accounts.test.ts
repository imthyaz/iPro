import { describe, expect, it } from 'vitest';
import { GraphError } from '../invites/graph-client.js';
import { GraphDirectoryAccounts } from './directory-accounts.js';

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const http = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responses.shift()!();
  }) as unknown as typeof fetch;
  return { http, calls };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const options = { tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'synthetic-secret' };

describe('disabling an Entra account at exit (decision #82)', () => {
  it('turns the account off, then ends its sign-in sessions', async () => {
    const { http, calls } = fakeFetch([
      () => json(200, { access_token: 'token-1', expires_in: 3600 }),
      () => new Response(null, { status: 204 }),
      () => json(200, { value: true }),
    ]);
    await new GraphDirectoryAccounts({ ...options, fetch: http }).disable('user-1');
    expect(calls[1]!.url).toBe('https://graph.microsoft.com/v1.0/users/user-1');
    expect(calls[1]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ accountEnabled: false });
    expect(calls[2]!.url).toBe(
      'https://graph.microsoft.com/v1.0/users/user-1/revokeSignInSessions',
    );
    expect(calls[2]!.init.headers).toMatchObject({ authorization: 'Bearer token-1' });
  });

  it('fails when the permission isn’t granted, so iPro can raise an IT task instead', async () => {
    const { http } = fakeFetch([
      () => json(200, { access_token: 'token-1', expires_in: 3600 }),
      () => json(403, { error: { code: 'Authorization_RequestDenied', message: 'denied' } }),
    ]);
    const error = await new GraphDirectoryAccounts({ ...options, fetch: http })
      .disable('user-1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphError);
  });
});
