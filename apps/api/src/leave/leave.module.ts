import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { businessDate } from '../common/effective-dating.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runWithContext } from '../context/request-context.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { LeaveController } from './leave.controller.js';
import { LeaveService } from './leave.service.js';

/** Spec: leave accrual on the 1st of each month at 01:00 IST; year end in January. */
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
      cron: '0 1 1 * *',
      run: () =>
        runWithContext({ tenantId: this.config.TENANT_ID }, () =>
          this.leave.runMonthly(businessDate(new Date())),
        ),
    });
  }
}

@Module({
  controllers: [LeaveController],
  providers: [LeaveService, LeaveJobs],
  exports: [LeaveService],
})
export class LeaveModule {}
