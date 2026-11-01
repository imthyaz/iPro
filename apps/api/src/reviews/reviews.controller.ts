import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { reviewQuerySchema, submitReviewSchema, type SubmitReviewInput } from '@ipro/shared';
import type { z } from 'zod';
import { AuthorizeAny, SignedIn } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ReviewsService } from './reviews.service.js';

const uuid = new ParseUUIDPipe();

/**
 * Probation reviews (M5, H7). Reading and submitting need a session here: the service checks the
 * probation_review permission on each person (team for managers, entity for HR, own after decision).
 */
@Controller()
export class ReviewsController {
  constructor(@Inject(ReviewsService) private readonly reviews: ReviewsService) {}

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
