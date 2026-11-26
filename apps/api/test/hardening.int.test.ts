import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, newTenant, signIn, testDb } from './helpers.js';
import { createTestApp } from './test-app.js';

/**
 * Slice 14d, security hardening ahead of the penetration test (decision #99): every API response
 * carries the security headers and is never cached; a browser on another site can't make a signed-in
 * user change anything; and the costly or public routes are rate limited. Synthetic users only.
 */
const USER = '00000000-0000-4000-8000-000000714d01';
const APP_URL = 'https://ipro.example.test';

const { pool, db } = testDb();
let app: INestApplication;
let cookie: string;

beforeAll(async () => {
  const tenant = await newTenant(pool, 'Hardening tests');
  await addUser(db, tenant, USER, 'Hd Employee', ['employee']);
  app = await createTestApp({
    TENANT_ID: tenant,
    APP_URL,
    RATE_LIMITS_ENABLED: 'true',
    RATE_LIMIT_ASK_PER_MINUTE: '3',
  });
  cookie = await signIn(app, USER);
}, 120_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('security headers (decision #99)', () => {
  it('every response, signed in or not, carries them and is never cached', async () => {
    for (const res of [
      await request(app.getHttpServer()).get('/api/health'),
      await request(app.getHttpServer()).get('/api/me'),
      await request(app.getHttpServer()).get('/api/me').set('Cookie', cookie),
    ]) {
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers).toMatchObject({
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'no-store',
        // HTTPS app: browsers must keep using HTTPS.
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
      });
    }
  });
});

describe('cross-site requests (decision #99)', () => {
  const post = (origin?: string, site?: string) => {
    const req = request(app.getHttpServer())
      .post('/api/notifications/read-all')
      .set('Cookie', cookie);
    if (origin) req.set('Origin', origin);
    if (site) req.set('Sec-Fetch-Site', site);
    return req;
  };

  it('a change from another site is refused, even with the session cookie', async () => {
    expect((await post('https://evil.example.test')).status).toBe(403);
    expect((await post(undefined, 'cross-site')).status).toBe(403);
  });

  it('the same site, and clients that send no origin, are let through', async () => {
    expect((await post(APP_URL, 'same-origin')).status).toBe(204);
    expect((await post()).status).toBe(204);
  });

  it('reads are not affected, and machine callers keep their own checks', async () => {
    const read = await request(app.getHttpServer())
      .get('/api/me')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example.test');
    expect(read.status).toBe(200);
    // The biometric device push is checked by its device key, not by origin.
    const punch = await request(app.getHttpServer())
      .post('/api/biometric/punches')
      .set('Origin', 'https://device.example.test')
      .send({ punches: [{ employeeCode: 'X', at: '2026-11-09T09:28:00+05:30', externalId: 'p' }] });
    expect(punch.status).toBe(401);
  });
});

describe('rate limits (decision #99)', () => {
  it('Ask iPro answers a few questions a minute per session, then says to wait', async () => {
    const ask = () =>
      request(app.getHttpServer())
        .post('/api/assistant/ask')
        .set('Cookie', cookie)
        .send({ text: 'How many leave days do I have?' });
    for (let i = 0; i < 3; i += 1) expect((await ask()).status).not.toBe(429);
    const limited = await ask();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body).toMatchObject({ message: expect.stringMatching(/try again/i) });
  });

  it('the public machine routes are limited per caller', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 125; i += 1) {
      statuses.push(
        (await request(app.getHttpServer()).post('/api/teams/messages').send({})).status,
      );
    }
    expect(statuses.slice(0, 120)).not.toContain(429);
    expect(statuses.at(-1)).toBe(429);
  });
});
