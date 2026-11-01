import { describe, expect, it } from 'vitest';
import { GraphError, GraphGuestInvites } from './guest-invites.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: ((call: Call) => Response)[]) {
  const calls: Call[] = [];
  const http = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return responses.shift()!(call);
  }) as unknown as typeof fetch;
  return { http, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const token = () => json(200, { access_token: 'token-1', expires_in: 3600 });

const options = {
  tenantId: 'tenant-1',
  clientId: 'client-1',
  clientSecret: 'synthetic-secret',
  groupId: 'group-1',
  redirectUrl: 'https://ipro.example.test',
};

describe('Graph guest invitations', () => {
  it('invites the email, then adds the guest to the pre-joiners group', async () => {
    const { http, calls } = fakeFetch([
      token,
      () => json(201, { invitedUser: { id: 'guest-1' } }),
      () => new Response(null, { status: 204 }),
    ]);
    const invites = new GraphGuestInvites({ ...options, fetch: http });
    await expect(
      invites.invite({ email: 'joiner@personal.test', displayName: 'Kavya Candidate' }),
    ).resolves.toEqual({ objectId: 'guest-1' });

    expect(calls[0]!.url).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
    expect(String(calls[0]!.init.body)).toContain(
      'scope=https%3A%2F%2Fgraph.microsoft.com%2F.default',
    );
    expect(calls[1]!.url).toBe('https://graph.microsoft.com/v1.0/invitations');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      invitedUserEmailAddress: 'joiner@personal.test',
      invitedUserDisplayName: 'Kavya Candidate',
      inviteRedirectUrl: 'https://ipro.example.test',
      sendInvitationMessage: true,
    });
    expect(calls[1]!.init.headers).toMatchObject({ authorization: 'Bearer token-1' });
    expect(calls[2]!.url).toBe('https://graph.microsoft.com/v1.0/groups/group-1/members/$ref');
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({
      '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/guest-1',
    });
  });

  it('a retry finds the guest already in the group', async () => {
    const { http } = fakeFetch([
      token,
      () => json(201, { invitedUser: { id: 'guest-1' } }),
      () =>
        json(400, {
          error: {
            code: 'Request_BadRequest',
            message: 'One or more added object references already exist',
          },
        }),
    ]);
    const invites = new GraphGuestInvites({ ...options, fetch: http });
    await expect(invites.invite({ email: 'a@personal.test', displayName: 'A' })).resolves.toEqual({
      objectId: 'guest-1',
    });
  });

  it('fails without putting the email address in the error message', async () => {
    const { http } = fakeFetch([
      token,
      () =>
        json(403, {
          error: { code: 'Authorization_RequestDenied', message: 'a@personal.test denied' },
        }),
    ]);
    const invites = new GraphGuestInvites({ ...options, fetch: http });
    const error = await invites
      .invite({ email: 'a@personal.test', displayName: 'A' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphError);
    expect((error as Error).message).toBe(
      'Microsoft Graph request failed (403 Authorization_RequestDenied)',
    );
    expect((error as Error).message).not.toContain('personal.test');
  });
});
