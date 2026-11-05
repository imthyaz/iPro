import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  leaveAdjustmentSchema,
  leaveImportSchema,
  leaveTypeInputSchema,
  leaveYearQuerySchema,
  type LeaveAdjustmentInput,
  type LeaveImportInput,
  type LeaveTypeInput,
} from '@ipro/shared';
import type { z } from 'zod';
import { Authorize, SignedIn } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { LeaveService } from './leave.service.js';

const uuid = new ParseUUIDPipe();

/** Leave types (A2), balances (E5, H9), HR adjustments and the cut-over import. */
@Controller()
export class LeaveController {
  constructor(@Inject(LeaveService) private readonly leave: LeaveService) {}

  @SignedIn()
  @Get('leave-types')
  types() {
    return this.leave.types();
  }

  @Authorize('org_config', 'create')
  @Post('leave-types')
  createType(@Body(new ZodPipe(leaveTypeInputSchema)) body: LeaveTypeInput) {
    return this.leave.createType(body);
  }

  @Authorize('org_config', 'update')
  @Put('leave-types/:id')
  updateType(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(leaveTypeInputSchema)) body: LeaveTypeInput,
  ) {
    return this.leave.updateType(id, body);
  }

  @Authorize('leave', 'read')
  @Get('people/:id/leave')
  balances(
    @Param('id', uuid) id: string,
    @Query(new ZodPipe(leaveYearQuerySchema)) query: z.infer<typeof leaveYearQuerySchema>,
  ) {
    return this.leave.balances(id, query.year);
  }

  @Authorize('leave', 'update')
  @Post('people/:id/leave/adjustments')
  adjust(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(leaveAdjustmentSchema)) body: LeaveAdjustmentInput,
  ) {
    return this.leave.adjust(id, body);
  }

  @Authorize('leave', 'update')
  @Post('leave/balances/import')
  @HttpCode(200)
  import(@Body(new ZodPipe(leaveImportSchema)) body: LeaveImportInput) {
    return this.leave.import(body);
  }
}
