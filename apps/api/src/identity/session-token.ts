import { createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'ipro_session';

/** 256 random bits; the cookie carries this, the database only its hash. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionTimes {
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface SessionPolicy {
  idleHours: number;
}

/** Valid until revoked, past the absolute expiry, or idle for longer than the policy allows. */
export function isSessionValid(session: SessionTimes, policy: SessionPolicy, now: Date): boolean {
  if (session.revokedAt) return false;
  if (now >= session.expiresAt) return false;
  const idleLimit = session.lastSeenAt.getTime() + policy.idleHours * 3_600_000;
  return now.getTime() < idleLimit;
}

/** Touch `last_seen_at` at most every 5 minutes, so reads don't each cost a write. */
export function shouldTouch(session: SessionTimes, now: Date): boolean {
  return now.getTime() - session.lastSeenAt.getTime() > 5 * 60_000;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function sessionCookie(
  token: string,
  options: { maxAgeSeconds: number; secure: boolean },
): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(options.maxAgeSeconds)}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie('', { maxAgeSeconds: 0, secure });
}

/** Only same-origin relative paths, so sign-in can't be used as an open redirect. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value.slice(0, 500);
}
