import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  createOfferSchema,
  joinOfferSchema,
  offerQuerySchema,
  offerReasonSchema,
  type CreateOfferInput,
} from '@ipro/shared';
import type { z } from 'zod';
import { Authorize } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { OffersService } from './offers.service.js';

const uuid = new ParseUUIDPipe();
type Reason = z.infer<typeof offerReasonSchema>;

/** Offers (H3, H4): HR drafts, sends and closes offers; approvals run through the workflow engine. */
@Controller('offers')
export class OffersController {
  constructor(@Inject(OffersService) private readonly offers: OffersService) {}

  @Authorize('assignment_history', 'read')
  @Get()
  list(@Query(new ZodPipe(offerQuerySchema)) query: z.infer<typeof offerQuerySchema>) {
    return this.offers.list(query.status);
  }

  @Authorize('assignment_history', 'read')
  @Get(':id')
  get(@Param('id', uuid) id: string) {
    return this.offers.get(id);
  }

  @Authorize('assignment_history', 'create')
  @Post()
  create(@Body(new ZodPipe(createOfferSchema)) body: CreateOfferInput) {
    return this.offers.create(body);
  }

  @Authorize('assignment_history', 'update')
  @Post(':id/submit')
  submit(@Param('id', uuid) id: string) {
    return this.offers.submit(id);
  }

  @Authorize('assignment_history', 'update')
  @Post(':id/decline')
  decline(@Param('id', uuid) id: string, @Body(new ZodPipe(offerReasonSchema)) body: Reason) {
    return this.offers.decline(id, body.reason);
  }

  @Authorize('assignment_history', 'update')
  @Post(':id/withdraw')
  withdraw(@Param('id', uuid) id: string, @Body(new ZodPipe(offerReasonSchema)) body: Reason) {
    return this.offers.withdraw(id, body.reason);
  }

  @Authorize('assignment_history', 'update')
  @Post(':id/no-show')
  noShow(@Param('id', uuid) id: string, @Body(new ZodPipe(offerReasonSchema)) body: Reason) {
    return this.offers.noShow(id, body.reason);
  }

  @Authorize('assignment_history', 'update')
  @Post(':id/join')
  join(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(joinOfferSchema)) body: z.infer<typeof joinOfferSchema>,
  ) {
    return this.offers.join(id, body.workEmail);
  }
}
