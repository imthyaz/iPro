import { Global, Module } from '@nestjs/common';
import { SESSION_RESOLVER } from '../authz/auth.guard.js';
import { AuthController, MeController } from './auth.controller.js';
import { DelegationsController } from './delegations.controller.js';
import { DelegationsService } from './delegations.service.js';
import { EntraOidcProvider, OIDC_PROVIDER } from './entra/oidc-provider.js';
import { SessionsService } from './sessions.service.js';
import { SignInService } from './sign-in.service.js';
import { UsersService } from './users.service.js';

@Global()
@Module({
  controllers: [AuthController, MeController, DelegationsController],
  providers: [
    UsersService,
    SessionsService,
    SignInService,
    DelegationsService,
    { provide: OIDC_PROVIDER, useClass: EntraOidcProvider },
    { provide: SESSION_RESOLVER, useExisting: SessionsService },
  ],
  exports: [SESSION_RESOLVER, UsersService, DelegationsService],
})
export class IdentityModule {}
