import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { currentContext, runWithContext, type Actor } from '../context/request-context.js';
import { AuthGuard, type SessionResolver } from './auth.guard.js';
import { AuthzService } from './authz.service.js';
import { Authorize, Public, SignedIn } from './decorators.js';
import { NoTeamScopeResolver } from './scope-resolver.js';

class Routes {
  @Public() health() {}
  @SignedIn() me() {}
  @Authorize('org_config', 'update') editOrg() {}
  undecorated() {}
}

const admin: Actor = {
  userId: 'u1',
  tenantId: 't',
  personId: null,
  roles: [{ role: 'admin', legalEntityId: null }],
};

const sessions: SessionResolver = {
  resolve: async (token) => (token === 'good' ? admin : null),
};

const guard = new AuthGuard(new Reflector(), new AuthzService(new NoTeamScopeResolver()), sessions);

function contextFor(handler: keyof Routes, cookie?: string): ExecutionContext {
  return {
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => ({ headers: { cookie } }) }),
  } as unknown as ExecutionContext;
}

const run = (handler: keyof Routes, cookie?: string) =>
  runWithContext({ tenantId: 't' }, async () => {
    const allowed = await guard.canActivate(contextFor(handler, cookie));
    return { allowed, actor: currentContext()?.actor };
  });

describe('AuthGuard', () => {
  it('lets public routes through without a session', async () => {
    expect((await run('health')).allowed).toBe(true);
  });

  it('denies routes that declare no access rule, even when signed in', async () => {
    await expect(run('undecorated', 'ipro_session=good')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('requires a valid session', async () => {
    await expect(run('me')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(run('me', 'ipro_session=expired')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('puts the actor in the request context', async () => {
    const result = await run('me', 'ipro_session=good');
    expect(result).toEqual({ allowed: true, actor: admin });
  });

  it('checks the route grant with authz', async () => {
    expect((await run('editOrg', 'ipro_session=good')).allowed).toBe(true);
    const employeeSessions: SessionResolver = {
      resolve: async () => ({ ...admin, roles: [{ role: 'employee', legalEntityId: null }] }),
    };
    const employeeGuard = new AuthGuard(
      new Reflector(),
      new AuthzService(new NoTeamScopeResolver()),
      employeeSessions,
    );
    await expect(
      runWithContext({ tenantId: 't' }, () =>
        employeeGuard.canActivate(contextFor('editOrg', 'ipro_session=any')),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
