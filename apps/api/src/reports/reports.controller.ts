import { Controller, Get, Inject, Query } from '@nestjs/common';
import { reportDateSchema, reportRangeSchema, reportYearSchema } from '@ipro/shared';
import { z } from 'zod';
import { AuthorizeAny } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ReportsService } from './reports.service.js';

type Range = z.infer<typeof reportRangeSchema>;

/**
 * H12 Phase 1 reports (decision #93). The route admits anyone holding a read of the report's area;
 * the service then keeps to the legal entities they may read entity-wide, and refuses team scope.
 */
@Controller('reports')
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  @AuthorizeAny(['profile', 'read'])
  @Get('headcount')
  headcount(@Query(new ZodPipe(reportDateSchema)) q: z.infer<typeof reportDateSchema>) {
    return this.reports.headcount(q.asOf);
  }

  @AuthorizeAny(['profile', 'read'])
  @Get('movement')
  movement(@Query(new ZodPipe(reportRangeSchema)) q: Range) {
    return this.reports.movement(q.from, q.to);
  }

  @AuthorizeAny(['profile', 'read'])
  @Get('attrition')
  attrition(@Query(new ZodPipe(reportRangeSchema)) q: Range) {
    return this.reports.attrition(q.from, q.to);
  }

  @AuthorizeAny(['attendance', 'read'])
  @Get('absenteeism')
  absenteeism(@Query(new ZodPipe(reportRangeSchema)) q: Range) {
    return this.reports.absenteeism(q.from, q.to);
  }

  @AuthorizeAny(['leave', 'read'])
  @Get('leave-liability')
  leaveLiability(@Query(new ZodPipe(reportYearSchema)) q: z.infer<typeof reportYearSchema>) {
    return this.reports.leaveLiability(q.year);
  }

  @AuthorizeAny(['hybrid_booking', 'read'])
  @Get('hybrid-compliance')
  hybridCompliance(@Query(new ZodPipe(reportRangeSchema)) q: Range) {
    return this.reports.hybridCompliance(q.from, q.to);
  }

  @AuthorizeAny(['hybrid_booking', 'read'])
  @Get('seat-occupancy')
  seatOccupancy(@Query(new ZodPipe(reportRangeSchema)) q: Range) {
    return this.reports.seatOccupancy(q.from, q.to);
  }
}
