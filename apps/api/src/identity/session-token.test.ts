import { describe, expect, it } from 'vitest';
import {
  hashSessionToken,
  isSessionValid,
  newSessionToken,
  readCookie,
  safeReturnTo,
  sessionCookie,
  shouldTouch,
} from './session-token.js';

const at = (iso: string) => new Date(iso);

describe('session tokens', () => {
  it('are random and stored only as a hash', () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(hashSessionToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(a)).not.toContain(a);
  });
});

describe('isSessionValid', () => {
  const session = {
    lastSeenAt: at('2026-11-02T09:00:00Z'),
    expiresAt: at('2026-11-09T09:00:00Z'),
    revokedAt: null,
  };
  const policy = { idleHours: 12 };

  it('accepts an active session', () => {
    expect(isSessionValid(session, policy, at('2026-11-02T20:59:00Z'))).toBe(true);
  });

  it('ends after the idle limit', () => {
    expect(isSessionValid(session, policy, at('2026-11-02T21:00:00Z'))).toBe(false);
  });

  it('ends at the absolute expiry even when active', () => {
    const active = { ...session, lastSeenAt: at('2026-11-09T08:59:00Z') };
    expect(isSessionValid(active, policy, at('2026-11-09T09:00:00Z'))).toBe(false);
  });

  it('ends when revoked', () => {
    const revoked = { ...session, revokedAt: at('2026-11-02T10:00:00Z') };
    expect(isSessionValid(revoked, policy, at('2026-11-02T10:01:00Z'))).toBe(false);
  });

  it('touches last-seen at most every 5 minutes', () => {
    expect(shouldTouch(session, at('2026-11-02T09:04:00Z'))).toBe(false);
    expect(shouldTouch(session, at('2026-11-02T09:06:00Z'))).toBe(true);
  });
});

describe('cookies', () => {
  it('reads one cookie among several', () => {
    expect(readCookie('a=1; ipro_session=abc; b=2', 'ipro_session')).toBe('abc');
    expect(readCookie('a=1', 'ipro_session')).toBeUndefined();
    expect(readCookie(undefined, 'ipro_session')).toBeUndefined();
  });

  it('sets HttpOnly, SameSite=Lax and Secure outside development', () => {
    const cookie = sessionCookie('abc', { maxAgeSeconds: 60, secure: true });
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(sessionCookie('abc', { maxAgeSeconds: 60, secure: false })).not.toContain('Secure');
  });
});

describe('safeReturnTo', () => {
  it.each([
    ['/leave?tab=mine', '/leave?tab=mine'],
    ['https://evil.example', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    [undefined, '/'],
  ])('%s -> %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });
});
