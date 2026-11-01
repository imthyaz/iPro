import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { RoleGrant } from '@ipro/shared';
import { APP_CONFIG, type AppConfig } from '../config.js';

/** The signed-in user, as authz sees them. */
export interface Actor {
  userId: string;
  tenantId: string;
  /** Linked once people records exist (slice 2); null until then. */
  personId: string | null;
  roles: RoleGrant[];
}

export interface RequestContext {
  requestId: string;
  tenantId: string;
  ip: string | null;
  userAgent: string | null;
  /** Set by the auth guard once the session is verified. */
  actor: Actor | null;
  /** The verified session (recorded with policy acceptances). */
  sessionId: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function requireContext(): RequestContext {
  const context = storage.getStore();
  if (!context) throw new Error('No request context');
  return context;
}

/** For jobs, seeds and tests: runs `fn` with a context that isn't tied to an HTTP request. */
export function runWithContext<T>(
  context: Partial<RequestContext> & { tenantId: string },
  fn: () => T,
): T {
  return storage.run(
    {
      requestId: randomUUID(),
      ip: null,
      userAgent: null,
      actor: null,
      sessionId: null,
      ...context,
    },
    fn,
  );
}

interface MinimalRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  use(req: MinimalRequest, _res: unknown, next: () => void): void {
    const userAgent = req.headers['user-agent'];
    storage.run(
      {
        requestId: randomUUID(),
        tenantId: this.config.TENANT_ID,
        ip: req.ip ?? null,
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 500) : null,
        actor: null,
        sessionId: null,
      },
      next,
    );
  }
}
