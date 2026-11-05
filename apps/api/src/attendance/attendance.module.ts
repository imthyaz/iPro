import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { addDays, businessDate } from '../common/effective-dating.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runWithContext } from '../context/request-context.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';
import { HolidaysController } from './holidays.controller.js';
import { HolidaysService } from './holidays.service.js';
import { ShiftsController } from './shifts.controller.js';
import { ShiftsService } from './shifts.service.js';

/** The attendance build (spec: every 15 minutes, full rebuild of the day before at 02:00 IST). */
@Injectable()
class AttendanceBuildJobs implements OnModuleInit {
  constructor(
    @Inject(ScheduledJobs) private readonly jobs: ScheduledJobs,
    @Inject(AttendanceService) private readonly attendance: AttendanceService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const tenant = { tenantId: this.config.TENANT_ID };
    this.jobs.register({
      name: 'attendance-build',
      cron: '*/15 * * * *',
      run: () => runWithContext(tenant, () => this.attendance.buildToday()),
    });
    this.jobs.register({
      name: 'attendance-rebuild',
      cron: '0 2 * * *',
      run: () =>
        runWithContext(tenant, () =>
          this.attendance.buildDay(addDays(businessDate(new Date()), -1)),
        ),
    });
  }
}

/** Shifts, holiday calendars, punches and attendance days; regularisation follows (slice 6c). */
@Module({
  controllers: [ShiftsController, HolidaysController, AttendanceController],
  providers: [ShiftsService, HolidaysService, AttendanceService, AttendanceBuildJobs],
  exports: [ShiftsService, AttendanceService],
})
export class AttendanceModule {}
