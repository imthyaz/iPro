import { Global, Module } from '@nestjs/common';
import { SCOPE_RESOLVER } from '../authz/scope-resolver.js';
import { JourneyService } from '../journey/journey.service.js';
import { PeopleScopeResolver } from './people-scope-resolver.js';
import { PeopleController } from './people.controller.js';
import { PeopleService } from './people.service.js';
import { SettingsService } from './settings.service.js';

/** Global so authz can use the team scope resolver it provides. */
@Global()
@Module({
  controllers: [PeopleController],
  providers: [
    PeopleService,
    SettingsService,
    JourneyService,
    { provide: SCOPE_RESOLVER, useClass: PeopleScopeResolver },
  ],
  exports: [PeopleService, SettingsService, JourneyService, SCOPE_RESOLVER],
})
export class PeopleModule {}
