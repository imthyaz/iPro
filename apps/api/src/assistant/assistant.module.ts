import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { runWithContext } from '../context/request-context.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { HybridModule } from '../hybrid/hybrid.module.js';
import { LeaveModule } from '../leave/leave.module.js';
import { LettersModule } from '../letters/letters.module.js';
import { PeopleModule } from '../people/people.module.js';
import { PoliciesModule } from '../policies/policies.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantService } from './assistant.service.js';
import { BriefService } from './brief.service.js';
import { AssistantRetentionService } from './retention.service.js';
import { BedrockLlm, LLM, NoLlm, ScriptedLlm, type Llm } from './llm.js';
import { AssistantTools } from './tools.js';

/** The 180-day retention at 02:30 and the daily brief at 09:00, India time (decision #92). */
@Injectable()
class AssistantJobs implements OnModuleInit {
  constructor(
    @Inject(ScheduledJobs) private readonly jobs: ScheduledJobs,
    @Inject(AssistantRetentionService) private readonly retention: AssistantRetentionService,
    @Inject(BriefService) private readonly brief: BriefService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: 'assistant-retention',
      cron: '30 2 * * *',
      run: () => runWithContext({ tenantId: this.config.TENANT_ID }, () => this.retention.run()),
    });
    this.jobs.register({
      name: 'daily-brief',
      cron: '0 9 * * *',
      run: () => runWithContext({ tenantId: this.config.TENANT_ID }, () => this.brief.run()),
    });
  }
}

/** Ask iPro (slice 12; decisions #88 to #92). */
@Module({
  imports: [
    AttendanceModule,
    HybridModule,
    LeaveModule,
    LettersModule,
    PeopleModule,
    PoliciesModule,
    ReviewsModule,
  ],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    AssistantTools,
    AssistantRetentionService,
    BriefService,
    AssistantJobs,
    {
      provide: LLM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Llm =>
        config.LLM_PROVIDER === 'bedrock'
          ? new BedrockLlm(
              {
                lookup: config.BEDROCK_MODEL_LOOKUP!,
                reasoning: config.BEDROCK_MODEL_REASONING!,
              },
              config.AWS_REGION,
            )
          : config.LLM_PROVIDER === 'none'
            ? new NoLlm()
            : new ScriptedLlm(),
    },
  ],
})
export class AssistantModule {}
