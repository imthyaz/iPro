import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { AuthzService } from './authz.service.js';

/** Needs SESSION_RESOLVER (identity module) and SCOPE_RESOLVER (people module), both global. */
@Global()
@Module({
  providers: [AuthzService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthzService],
})
export class AuthzModule {}
