import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runWithContext } from '../context/request-context.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { PoliciesController } from './policies.controller.js';
import { PoliciesService } from './policies.service.js';

/** Hourly: reads the text of versions published before Ask iPro, or not read yet (decision #89). */
@Injectable()
class PolicyTextJob implements OnModuleInit {
  constructor(
    @Inject(ScheduledJobs) private readonly jobs: ScheduledJobs,
    @Inject(PoliciesService) private readonly policies: PoliciesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: 'policy-text',
      cron: '0 * * * *',
      run: () =>
        runWithContext({ tenantId: this.config.TENANT_ID }, () => this.policies.readPending()),
    });
  }
}

/** Policy documents, in-app acknowledgements, and their clauses for Ask iPro. */
@Module({
  controllers: [PoliciesController],
  providers: [PoliciesService, PolicyTextJob],
  exports: [PoliciesService],
})
export class PoliciesModule {}
