import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { Authorize } from '../authz/decorators.js';
import { TimelineService } from './timeline.service.js';

/** E8 My journey, and the full journey on a person's record (H2): one person's timeline. */
@Controller()
export class TimelineController {
  constructor(@Inject(TimelineService) private readonly timelines: TimelineService) {}

  @Authorize('journey_public', 'read')
  @Get('people/:id/timeline')
  person(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.timelines.personTimeline(id);
  }
}
