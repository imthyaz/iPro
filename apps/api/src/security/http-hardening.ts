import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { SESSION_COOKIE, readCookie } from '../identity/session-token.js';

/**
 * HTTP hardening (slice 14d; decision #99), applied by `configureApp` to the real server and to every
 * test app, so tests see what production sees.
 *
 * - Security headers on every response, and `no-store`: API responses carry personal data.
 * - Cross-site changes refused: a POST/PUT/PATCH/DELETE from a browser on another site is rejected
 *   even though the session cookie would be sent. The machine routes (device push, e-sign webhook,
 *   Teams bot) have their own credentials and are exempt.
 * - Rate limits on the costly route (Ask iPro, per session) and the public routes (per caller).
 *   Counted in memory per API task: with N tasks the limit is N times higher, which is still a
 *   ceiling; an edge (WAF) limit can be added in front later.
 */

interface Req {
  method: string;
  path: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  setHeader(name: string, value: string): void;
  status(code: number): Res;
  json(body: unknown): void;
}
type Next = () => void;

const header = (req: Req, name: string) => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** Machine callers with their own credentials: no browser origin applies. */
export const MACHINE_ROUTES = new Set([
  'POST /api/biometric/punches',
  'POST /api/esign/webhook',
  'POST /api/teams/messages',
]);

export function securityHeaders(https: boolean) {
  return (_req: Req, res: Res, next: Next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function refuseCrossSite(appOrigin: string) {
  return (req: Req, res: Res, next: Next) => {
    if (!UNSAFE.has(req.method) || MACHINE_ROUTES.has(`${req.method} ${req.path}`)) return next();
    const origin = header(req, 'origin');
    const site = header(req, 'sec-fetch-site');
    if ((origin && origin !== appOrigin) || site === 'cross-site') {
      res.status(403).json({ statusCode: 403, message: 'Requests from other sites are refused' });
      return;
    }
    next();
  };
}

/** Fixed one-minute windows, counted in memory. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly windowMs = 60_000) {}

  /** Seconds to wait, or 0 when the call is allowed. */
  hit(key: string, limit: number, now = Date.now()): number {
    const window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 10_000) this.sweep(now);
      return 0;
    }
    window.count += 1;
    if (window.count <= limit) return 0;
    return Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000));
  }

  private sweep(now: number) {
    for (const [key, w] of this.windows) {
      if (now - w.start >= this.windowMs) this.windows.delete(key);
    }
  }
}

interface Rule {
  routes: string[];
  limit: number;
  /** Per session (hashed, never the token itself) or per calling address. */
  by: 'session' | 'caller';
}

export function rateLimit(rules: Rule[], limiter = new RateLimiter()) {
  return (req: Req, res: Res, next: Next) => {
    const route = `${req.method} ${req.path}`;
    const rule = rules.find((r) => r.routes.includes(route));
    if (!rule) return next();
    const token = readCookie(header(req, 'cookie'), SESSION_COOKIE);
    const who =
      rule.by === 'session' && token
        ? `s:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`
        : `ip:${req.ip ?? 'unknown'}`;
    const wait = limiter.hit(`${route}|${who}`, rule.limit);
    if (wait === 0) return next();
    res.setHeader('Retry-After', String(wait));
    res
      .status(429)
      .json({ statusCode: 429, message: `Too many requests. Try again in ${wait} seconds.` });
  };
}

/** Everything main.ts and the test app share: the API prefix and the hardening above. */
export function configureApp(app: INestApplication, config: AppConfig): void {
  app.setGlobalPrefix('api');
  const express = app.getHttpAdapter().getInstance() as {
    disable(name: string): void;
    set(name: string, value: unknown): void;
  };
  express.disable('x-powered-by');
  // Behind the load balancer, the caller's address is the last hop it adds.
  if (config.TRUST_PROXY_HOPS > 0) express.set('trust proxy', config.TRUST_PROXY_HOPS);
  const appUrl = new URL(config.APP_URL);
  app.use(securityHeaders(appUrl.protocol === 'https:'));
  app.use(refuseCrossSite(appUrl.origin));
  if (config.RATE_LIMITS_ENABLED) {
    app.use(
      rateLimit([
        {
          routes: ['POST /api/assistant/ask'],
          limit: config.RATE_LIMIT_ASK_PER_MINUTE,
          by: 'session',
        },
        { routes: ['GET /api/auth/login', 'GET /api/auth/callback'], limit: 20, by: 'caller' },
        { routes: [...MACHINE_ROUTES], limit: 120, by: 'caller' },
      ]),
    );
  }
}
