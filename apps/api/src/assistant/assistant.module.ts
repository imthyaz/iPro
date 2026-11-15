import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { HybridModule } from '../hybrid/hybrid.module.js';
import { LeaveModule } from '../leave/leave.module.js';
import { PeopleModule } from '../people/people.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantService } from './assistant.service.js';
import { BedrockLlm, LLM, NoLlm, ScriptedLlm, type Llm } from './llm.js';
import { AssistantTools } from './tools.js';

/** Ask iPro (slice 12; decision #88). */
@Module({
  imports: [AttendanceModule, HybridModule, LeaveModule, PeopleModule, ReviewsModule],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    AssistantTools,
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
