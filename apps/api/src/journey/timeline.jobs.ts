import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runWithContext } from '../context/request-context.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { TimelineService } from './timeline.service.js';

/** Daily at 00:30 IST (decision #84): the next work anniversaries and planned probation ends. */
@Injectable()
export class TimelineJobs implements OnModuleInit {
  constructor(
    @Inject(ScheduledJobs) private readonly jobs: ScheduledJobs,
    @Inject(TimelineService) private readonly timelines: TimelineService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: 'journey-plan-ahead',
      cron: '30 0 * * *',
      run: () =>
        runWithContext({ tenantId: this.config.TENANT_ID }, () => this.timelines.planAhead()),
    });
  }
}
