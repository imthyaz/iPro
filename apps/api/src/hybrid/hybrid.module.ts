import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runWithContext } from '../context/request-context.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { businessDate } from '../common/effective-dating.js';
import { ComplianceService } from './compliance.service.js';
import { HybridController } from './hybrid.controller.js';
import { HybridService } from './hybrid.service.js';

/**
 * Spec notifications: "Hybrid week below policy", Friday 12:00 IST for the next week. Spec job
 * "Hybrid compliance": daily at 03:00, with last week recorded again on Monday.
 */
@Injectable()
class HybridJobs implements OnModuleInit {
  constructor(
    @Inject(ScheduledJobs) private readonly jobs: ScheduledJobs,
    @Inject(HybridService) private readonly hybrid: HybridService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: 'hybrid-below-policy-reminder',
      cron: '0 12 * * 5',
      run: () =>
        runWithContext({ tenantId: this.config.TENANT_ID }, () => this.hybrid.remindBelowPolicy()),
    });
    this.jobs.register({
      name: 'hybrid-compliance',
      cron: '0 3 * * *',
      run: () =>
        runWithContext({ tenantId: this.config.TENANT_ID }, () =>
          this.compliance.runDaily(businessDate(new Date())),
        ),
    });
  }
}

@Module({
  imports: [AttendanceModule],
  controllers: [HybridController],
  providers: [HybridService, ComplianceService, HybridJobs],
  exports: [HybridService],
})
export class HybridModule {}
