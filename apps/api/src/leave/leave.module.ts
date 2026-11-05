import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { businessDate } from '../common/effective-dating.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runWithContext } from '../context/request-context.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { LeaveController } from './leave.controller.js';
import { LeaveRequestsController } from './requests.controller.js';
import { LeaveRequestsService } from './requests.service.js';
import { LeaveService } from './leave.service.js';

/**
 * Leave accrual daily at 01:00 IST (decision #73: the spec's 1st-of-month run, made daily so joiners
 * are credited the day after joining); year end in January.
 */
@Injectable()
class LeaveJobs implements OnModuleInit {
  constructor(
    @Inject(ScheduledJobs) private readonly jobs: ScheduledJobs,
    @Inject(LeaveService) private readonly leave: LeaveService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: 'leave-accrual',
      cron: '0 1 * * *',
      run: () =>
        runWithContext({ tenantId: this.config.TENANT_ID }, () =>
          this.leave.runDaily(businessDate(new Date())),
        ),
    });
  }
}

@Module({
  imports: [AttendanceModule],
  controllers: [LeaveController, LeaveRequestsController],
  providers: [LeaveService, LeaveRequestsService, LeaveJobs],
  exports: [LeaveService],
})
export class LeaveModule {}
