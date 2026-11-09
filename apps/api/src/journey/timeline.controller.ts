import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { teamJourneysQuerySchema } from '@ipro/shared';
import type { z } from 'zod';
import { Authorize } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { TeamJourneysService } from './team-journeys.service.js';
import { TimelineService } from './timeline.service.js';

/** E8 My journey, and the full journey on a person's record (H2): one person's timeline. */
@Controller()
export class TimelineController {
  constructor(
    @Inject(TimelineService) private readonly timelines: TimelineService,
    @Inject(TeamJourneysService) private readonly teams: TeamJourneysService,
  ) {}

  /** M6 Team journeys (managers) and H11 (HR and CXO, org-wide). */
  @Authorize('journey_public', 'read')
  @Get('journeys/team')
  team(
    @Query(new ZodPipe(teamJourneysQuerySchema)) query: z.infer<typeof teamJourneysQuerySchema>,
  ) {
    return this.teams.team(query);
  }

  @Authorize('journey_public', 'read')
  @Get('people/:id/timeline')
  person(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.timelines.personTimeline(id);
  }
}
