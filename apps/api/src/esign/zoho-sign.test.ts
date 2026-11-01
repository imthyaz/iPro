import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeEsign } from './esign.js';
import { pageCount, ZohoSign } from './zoho-sign.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Pages >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type /Page >> endobj\n',
);

/** A scripted Zoho: records calls and answers by path. */
function zohoFake(status = 'inprogress') {
  const calls: { method: string; url: string; auth?: string; body?: unknown }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string> | undefined;
    calls.push({
      method: init.method ?? 'GET',
      url,
      auth: headers?.Authorization,
      body: init.body,
    });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.endsWith('/oauth/v2/token')) return json({ access_token: 'tok-1', expires_in: 3600 });
    if (url.endsWith('/api/v1/requests') && init.method === 'POST') {
      return json({
        requests: {
          request_id: '9001',
          document_ids: [{ document_id: 'd1' }],
          actions: [{ action_id: 'a1' }],
        },
      });
    }
    if (url.endsWith('/submit')) return json({ status: 'success' });
    if (url.endsWith('/pdf')) return new Response(Buffer.from('%PDF signed'), { status: 200 });
    if (url.endsWith('/recall')) return json({ status: 'success' });
    if (url.includes('/api/v1/requests/')) return json({ requests: { request_status: status } });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const options = (fetchFn: typeof fetch, webhookSecret?: string) => ({
  accountsUrl: 'https://accounts.zoho.in',
  signUrl: 'https://sign.zoho.in',
  clientId: 'id',
  clientSecret: 'secret',
  refreshToken: 'refresh',
  webhookSecret,
  webhookHeader: 'X-ZS-WEBHOOK-SIGNATURE',
  fetch: fetchFn,
});

const request = {
  pdf: PDF,
  fileName: 'letter.pdf',
  title: 'Confirmation letter',
  signer: { name: 'Test Person', email: 'test.person@example.test' },
  reference: 'letter-1',
};

describe('pageCount', () => {
  it('counts page objects, not the page tree', () => {
    expect(pageCount(PDF)).toBe(2);
    expect(pageCount(Buffer.from('not a pdf'))).toBe(1);
  });
});

describe('ZohoSign', () => {
  it('creates and submits a request with a signature field on the last page, in India', async () => {
    const { calls, fetchFn } = zohoFake();
    const zoho = new ZohoSign(options(fetchFn));
    expect(await zoho.send(request)).toEqual({ requestId: '9001' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://accounts.zoho.in/oauth/v2/token',
      'POST https://sign.zoho.in/api/v1/requests',
      'POST https://sign.zoho.in/api/v1/requests/9001/submit',
    ]);
    expect(calls[1]!.auth).toBe('Zoho-oauthtoken tok-1');
    const submitted = JSON.parse((calls[2]!.body as URLSearchParams).get('data')!);
    expect(submitted.requests.actions[0].fields[0]).toMatchObject({
      field_type_name: 'Signature',
      page_no: 1,
      document_id: 'd1',
    });
  });

  it('reuses the access token until it expires', async () => {
    const { calls, fetchFn } = zohoFake();
    const zoho = new ZohoSign(options(fetchFn));
    await zoho.status('9001');
    await zoho.status('9001');
    expect(calls.filter((c) => c.url.endsWith('/oauth/v2/token'))).toHaveLength(1);
  });

  it('maps statuses and downloads the signed PDF when complete', async () => {
    expect(await new ZohoSign(options(zohoFake('inprogress').fetchFn)).status('9001')).toEqual({
      state: 'pending',
    });
    expect(await new ZohoSign(options(zohoFake('declined').fetchFn)).status('9001')).toEqual({
      state: 'declined',
    });
    expect(await new ZohoSign(options(zohoFake('expired').fetchFn)).status('9001')).toEqual({
      state: 'cancelled',
    });
    const signed = await new ZohoSign(options(zohoFake('completed').fetchFn)).status('9001');
    expect(signed.state === 'signed' && signed.signedPdf.toString()).toBe('%PDF signed');
  });

  it('accepts only webhooks signed with the shared secret, and only to learn the request id', () => {
    const zoho = new ZohoSign(options(zohoFake().fetchFn, 'hook-secret'));
    const body = Buffer.from(
      JSON.stringify({ requests: { request_id: 9001, request_status: 'completed' } }),
    );
    const good = createHmac('sha256', 'hook-secret').update(body).digest('base64');
    expect(zoho.webhookRequestId(body, { 'x-zs-webhook-signature': good })).toBe('9001');
    expect(zoho.webhookRequestId(body, { 'x-zs-webhook-signature': 'forged' })).toBeNull();
    expect(zoho.webhookRequestId(body, {})).toBeNull();
  });

  it('never puts response bodies (names, emails) in errors', async () => {
    const failing = (async () =>
      new Response('{"error":"test.person@example.test"}', {
        status: 500,
      })) as unknown as typeof fetch;
    await expect(new ZohoSign(options(failing)).status('9001')).rejects.toThrow(
      'Zoho token request failed (500)',
    );
  });
});

describe('FakeEsign', () => {
  it('signs, declines and cancels on request', async () => {
    const fake = new FakeEsign();
    const { requestId } = await fake.send(request);
    expect(await fake.status(requestId)).toEqual({ state: 'pending' });
    fake.sign(requestId);
    const signed = await fake.status(requestId);
    expect(signed.state === 'signed' && signed.signedPdf.toString()).toContain(
      'Signed by test.person@example.test',
    );
    expect(fake.webhookRequestId(Buffer.from(JSON.stringify({ requestId })))).toBe(requestId);
    expect(fake.webhookRequestId(Buffer.from('{"requestId":"unknown"}'))).toBeNull();
  });
});
