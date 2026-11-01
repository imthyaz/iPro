import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  allocateShiftSchema,
  isoDateSchema,
  shiftInputSchema,
  shiftUpdateSchema,
  type AllocateShiftInput,
  type ShiftInput,
} from '@ipro/shared';
import { z } from 'zod';
import { Authorize, AuthorizeAny } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ShiftsService } from './shifts.service.js';

const uuid = new ParseUUIDPipe();
const rangeSchema = z.object({ from: isoDateSchema, to: isoDateSchema });

/** Shifts (A2) and shift allocations (per person or a whole project team). */
@Controller()
export class ShiftsController {
  constructor(@Inject(ShiftsService) private readonly shifts: ShiftsService) {}

  @AuthorizeAny(['org_config', 'read'], ['attendance', 'approve'])
  @Get('shifts')
  list() {
    return this.shifts.list();
  }

  @Authorize('org_config', 'create')
  @Post('shifts')
  create(@Body(new ZodPipe(shiftInputSchema)) body: ShiftInput) {
    return this.shifts.create(body);
  }

  @Authorize('org_config', 'update')
  @Patch('shifts/:id')
  update(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(shiftUpdateSchema)) body: Partial<ShiftInput>,
  ) {
    return this.shifts.update(id, body);
  }

  @Authorize('assignment_history', 'update')
  @Post('shifts/allocations')
  allocate(@Body(new ZodPipe(allocateShiftSchema)) body: AllocateShiftInput) {
    return this.shifts.allocate(body);
  }

  @Authorize('assignment_history', 'read')
  @Get('people/:id/shifts')
  history(@Param('id', uuid) id: string) {
    return this.shifts.history(id);
  }

  @Authorize('attendance', 'read')
  @Get('people/:id/working-days')
  workingDays(
    @Param('id', uuid) id: string,
    @Query(new ZodPipe(rangeSchema)) range: z.infer<typeof rangeSchema>,
  ) {
    return this.shifts.workingDays(id, range.from, range.to);
  }
}
