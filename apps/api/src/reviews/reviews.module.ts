import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runWithContext } from '../context/request-context.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { ChangesModule } from '../changes/changes.module.js';
import { LettersModule } from '../letters/letters.module.js';
import { CheckInsService } from './check-ins.service.js';
import { ReviewsController } from './reviews.controller.js';
import { ReviewsService } from './reviews.service.js';

/** Daily at 06:00 IST (spec: probation due dates): opens reviews, reminds, escalates. */
@Injectable()
class ProbationSweepJob implements OnModuleInit {
  constructor(
    @Inject(ScheduledJobs) private readonly jobs: ScheduledJobs,
    @Inject(ReviewsService) private readonly reviews: ReviewsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: 'probation-sweep',
      cron: '0 6 * * *',
      run: () => runWithContext({ tenantId: this.config.TENANT_ID }, () => this.reviews.sweep()),
    });
  }
}

@Module({
  imports: [LettersModule, ChangesModule],
  controllers: [ReviewsController],
  providers: [ReviewsService, CheckInsService, ProbationSweepJob],
  exports: [ReviewsService],
})
export class ReviewsModule {}
