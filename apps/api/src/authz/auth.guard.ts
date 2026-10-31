import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { requireContext, type Actor } from '../context/request-context.js';
import { SESSION_COOKIE, readCookie } from '../identity/session-token.js';
import { ACCESS_KEY, type RouteAccess } from './decorators.js';
import { AuthzService } from './authz.service.js';

/** Resolves a session token to an actor. Implemented by the identity module. */
export interface SessionResolver {
  resolve(token: string): Promise<Actor | null>;
}
export const SESSION_RESOLVER = Symbol('SESSION_RESOLVER');

/**
 * Global guard on every route: authenticates the session, then applies the route's access rule.
 * Deny by default: a route with no access decorator is refused.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(SESSION_RESOLVER) private readonly sessions: SessionResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<RouteAccess | undefined>(ACCESS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!access) throw new ForbiddenException();
    if (access.kind === 'public') return true;

    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const actor = token ? await this.sessions.resolve(token) : null;
    if (!actor) throw new UnauthorizedException();
    requireContext().actor = actor;

    if (access.kind === 'signed-in') return true;
    const grants =
      access.kind === 'authorize' ? [[access.area, access.action] as const] : access.grants;
    if (!grants.some(([area, action]) => this.authz.can(actor, area, action))) {
      throw new ForbiddenException();
    }
    return true;
  }
}
