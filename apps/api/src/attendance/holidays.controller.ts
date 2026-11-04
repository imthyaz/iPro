import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  holidayCalendarInputSchema,
  holidayInputSchema,
  type HolidayCalendarInput,
  type HolidayInput,
} from '@ipro/shared';
import { z } from 'zod';
import { Authorize } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { HolidaysService } from './holidays.service.js';

const uuid = new ParseUUIDPipe();
const yearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });

/** Holiday calendars (A2): company calendars per location, and customers' calendars (decision #48). */
@Controller('holiday-calendars')
export class HolidaysController {
  constructor(@Inject(HolidaysService) private readonly holidays: HolidaysService) {}

  @Authorize('org_config', 'read')
  @Get()
  list(@Query(new ZodPipe(yearQuery)) query: z.infer<typeof yearQuery>) {
    return this.holidays.list(query.year);
  }

  @Authorize('org_config', 'create')
  @Post()
  create(@Body(new ZodPipe(holidayCalendarInputSchema)) body: HolidayCalendarInput) {
    return this.holidays.create(body);
  }

  @Authorize('org_config', 'read')
  @Get(':id')
  get(
    @Param('id', uuid) id: string,
    @Query(new ZodPipe(yearQuery)) query: z.infer<typeof yearQuery>,
  ) {
    return this.holidays.get(id, query.year);
  }

  @Authorize('org_config', 'update')
  @Post(':id/holidays')
  addHoliday(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(holidayInputSchema)) body: HolidayInput,
  ) {
    return this.holidays.addHoliday(id, body);
  }

  @Authorize('org_config', 'update')
  @Delete(':id/holidays/:holidayId')
  removeHoliday(@Param('id', uuid) id: string, @Param('holidayId', uuid) holidayId: string) {
    return this.holidays.removeHoliday(id, holidayId);
  }
}
