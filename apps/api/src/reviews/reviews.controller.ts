import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  recordCheckInSchema,
  reviewQuerySchema,
  submitReviewSchema,
  type SubmitReviewInput,
} from '@ipro/shared';
import { z as zod } from 'zod';
import type { z } from 'zod';
import { AuthorizeAny, SignedIn } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CheckInsService } from './check-ins.service.js';
import { ReviewsService } from './reviews.service.js';

const checkInQuery = zod.object({ open: zod.enum(['true', 'false']).optional() });

const uuid = new ParseUUIDPipe();

/**
 * Probation reviews (M5, H7). Reading and submitting need a session here: the service checks the
 * probation_review permission on each person (team for managers, entity for HR, own after decision).
 */
@Controller()
export class ReviewsController {
  constructor(
    @Inject(ReviewsService) private readonly reviews: ReviewsService,
    @Inject(CheckInsService) private readonly checkIns: CheckInsService,
  ) {}

  /** Monthly probation check-ins (decision #63): the ones to record, or a team's / everyone's. */
  @SignedIn()
  @Get('check-ins')
  listCheckIns(@Query(new ZodPipe(checkInQuery)) query: zod.infer<typeof checkInQuery>) {
    return this.checkIns.list({ open: query.open === 'true' });
  }

  @SignedIn()
  @Post('check-ins/:id')
  recordCheckIn(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(recordCheckInSchema)) body: zod.infer<typeof recordCheckInSchema>,
  ) {
    return this.checkIns.record(id, body.progress, body.notes);
  }

  @SignedIn()
  @Get('reviews')
  list(@Query(new ZodPipe(reviewQuerySchema)) query: z.infer<typeof reviewQuerySchema>) {
    return this.reviews.list(query.status);
  }

  @SignedIn()
  @Get('reviews/:id')
  get(@Param('id', uuid) id: string) {
    return this.reviews.get(id);
  }

  @SignedIn()
  @Post('reviews/:id/submit')
  submit(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(submitReviewSchema)) body: SubmitReviewInput,
  ) {
    return this.reviews.submit(id, body);
  }

  /** For those who act on reviews: managers write them, HR decides, HR head ends employment. */
  @AuthorizeAny(
    ['probation_review', 'create'],
    ['probation_review', 'approve'],
    ['probation_review', 'terminate'],
  )
  @Get('probation/dashboard')
  dashboard() {
    return this.reviews.dashboard();
  }
}
