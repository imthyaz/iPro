import { describe, expect, it } from 'vitest';
import { BOT_ISSUER, verifyBotToken } from './bot-auth.js';
import { TestBotKeys } from './bot-test-keys.js';

const keys = new TestBotKeys();
const appId = '00000000-0000-4000-8000-00000000b071';
const serviceUrl = 'https://smba.trafficmanager.net/in/';
const now = new Date('2026-11-09T04:00:00Z');
const at = Math.floor(now.getTime() / 1000);
const good = { iss: BOT_ISSUER, aud: appId, exp: at + 3600, nbf: at - 60, serviceurl: serviceUrl };
const check = (token: string | undefined, extra: Partial<{ serviceUrl: string }> = {}) =>
  verifyBotToken(token === undefined ? undefined : `Bearer ${token}`, {
    appId,
    serviceUrl,
    channelId: 'msteams',
    keys,
    now,
    ...extra,
  });

describe('Bot Framework tokens (decision #87)', () => {
  it('accepts a token Microsoft signed for this bot and service URL', async () => {
    await expect(check(keys.sign(good))).resolves.toMatchObject({ aud: appId });
  });

  it.each([
    ['no token', undefined, 'No bearer token'],
    ['another bot', keys.sign({ ...good, aud: 'someone-else' }), 'Wrong audience'],
    ['another issuer', keys.sign({ ...good, iss: 'https://evil.example.test' }), 'Wrong issuer'],
    ['an expired token', keys.sign({ ...good, exp: at - 3600 }), 'Expired'],
    ['an unknown key', keys.sign(good, 'other-key'), 'Unknown signing key'],
    [
      'a tampered payload',
      `${keys.sign(good).split('.')[0]}.${Buffer.from(JSON.stringify({ ...good, aud: appId, exp: at + 99999 })).toString('base64url')}.${keys.sign(good).split('.')[2]}`,
      'Bad signature',
    ],
  ])('refuses %s', async (_name, token, message) => {
    await expect(check(token)).rejects.toThrow(message);
  });

  it('refuses a token issued for another service URL', async () => {
    await expect(
      check(keys.sign(good), { serviceUrl: 'https://attacker.example.test/' }),
    ).rejects.toThrow('Service URL mismatch');
  });
});
