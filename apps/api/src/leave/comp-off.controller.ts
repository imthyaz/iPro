import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { compOffRequestSchema, leaveYearQuerySchema, type CompOffRequestInput } from '@ipro/shared';
import type { z } from 'zod';
import { Authorize } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CompOffService } from './comp-off.service.js';

/** Comp-off (decision #76): the employee asks; the manager approves in the Action inbox. */
@Controller('leave/comp-off')
export class CompOffController {
  constructor(@Inject(CompOffService) private readonly compOff: CompOffService) {}

  @Authorize('leave', 'create')
  @Post()
  request(@Body(new ZodPipe(compOffRequestSchema)) body: CompOffRequestInput) {
    return this.compOff.request(body);
  }

  @Authorize('leave', 'read')
  @Get('mine')
  mine(@Query(new ZodPipe(leaveYearQuerySchema)) query: z.infer<typeof leaveYearQuerySchema>) {
    return this.compOff.mine(query.year);
  }

  @Authorize('leave', 'cancel')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.compOff.cancel(id);
  }
}
