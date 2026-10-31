import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { AuthzService } from './authz.service.js';
import { NoTeamScopeResolver, SCOPE_RESOLVER } from './scope-resolver.js';

/** Needs SESSION_RESOLVER from the (global) identity module. */
@Global()
@Module({
  providers: [
    AuthzService,
    { provide: SCOPE_RESOLVER, useClass: NoTeamScopeResolver },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthzService],
})
export class AuthzModule {}
