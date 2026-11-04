import { Module } from '@nestjs/common';
import { HolidaysController } from './holidays.controller.js';
import { HolidaysService } from './holidays.service.js';
import { ShiftsController } from './shifts.controller.js';
import { ShiftsService } from './shifts.service.js';

/** Shifts, holiday calendars and working calendars; punches, attendance days and regularisation next. */
@Module({
  controllers: [ShiftsController, HolidaysController],
  providers: [ShiftsService, HolidaysService],
  exports: [ShiftsService],
})
export class AttendanceModule {}
