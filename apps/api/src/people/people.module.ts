import { Global, Module } from '@nestjs/common';
import { SCOPE_RESOLVER } from '../authz/scope-resolver.js';
import { JourneyService } from '../journey/journey.service.js';
import { TimelineController } from '../journey/timeline.controller.js';
import { TimelineJobs } from '../journey/timeline.jobs.js';
import { TimelineService } from '../journey/timeline.service.js';
import { DocumentsService } from './documents.service.js';
import { KycDocumentsController } from './kyc-documents.controller.js';
import { KycService } from './kyc.service.js';
import { OrgTreeController } from './org-tree.controller.js';
import { OrgTreeService } from './org-tree.service.js';
import { PeopleScopeResolver } from './people-scope-resolver.js';
import { PeopleController } from './people.controller.js';
import { PeopleService } from './people.service.js';
import { SettingsService } from './settings.service.js';

/** Global so authz can use the team scope resolver it provides. */
@Global()
@Module({
  controllers: [PeopleController, KycDocumentsController, OrgTreeController, TimelineController],
  providers: [
    PeopleService,
    KycService,
    DocumentsService,
    OrgTreeService,
    SettingsService,
    JourneyService,
    TimelineService,
    TimelineJobs,
    { provide: SCOPE_RESOLVER, useClass: PeopleScopeResolver },
  ],
  exports: [PeopleService, SettingsService, JourneyService, DocumentsService, SCOPE_RESOLVER],
})
export class PeopleModule {}
