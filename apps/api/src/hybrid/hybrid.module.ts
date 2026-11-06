import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runWithContext } from '../context/request-context.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { HybridController } from './hybrid.controller.js';
import { HybridService } from './hybrid.service.js';

/** Spec notifications: "Hybrid week below policy", Friday 12:00 IST for the next week. */
@Injectable()
class HybridJobs implements OnModuleInit {
  constructor(
    @Inject(ScheduledJobs) private readonly jobs: ScheduledJobs,
    @Inject(HybridService) private readonly hybrid: HybridService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: 'hybrid-below-policy-reminder',
      cron: '0 12 * * 5',
      run: () =>
        runWithContext({ tenantId: this.config.TENANT_ID }, () => this.hybrid.remindBelowPolicy()),
    });
  }
}

@Module({
  imports: [AttendanceModule],
  controllers: [HybridController],
  providers: [HybridService, HybridJobs],
  exports: [HybridService],
})
export class HybridModule {}
