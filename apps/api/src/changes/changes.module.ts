import {
  Body,
  Controller,
  Inject,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  type OnModuleInit,
} from '@nestjs/common';
import {
  conversionRequestSchema,
  inLifeChangeSchema,
  payChangeSchema,
  type ConversionRequestInput,
  type InLifeChangeInput,
  type PayChangeInput,
} from '@ipro/shared';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runWithContext } from '../context/request-context.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { Authorize } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { LettersModule } from '../letters/letters.module.js';
import { ChangesService } from './changes.service.js';
import { PayConversionsService } from './pay-conversions.service.js';

const uuid = new ParseUUIDPipe();

/** In-life change, pay change and conversion requests (H6). HR asks; approvals run through the engine. */
@Controller()
export class ChangesController {
  constructor(
    @Inject(ChangesService) private readonly changes: ChangesService,
    @Inject(PayConversionsService) private readonly payConversions: PayConversionsService,
  ) {}

  @Authorize('assignment_history', 'update')
  @Post('people/:id/changes')
  request(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(inLifeChangeSchema)) body: InLifeChangeInput,
  ) {
    return this.changes.request(id, body);
  }

  @Authorize('compensation', 'update')
  @Post('people/:id/pay-changes')
  requestPay(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(payChangeSchema)) body: PayChangeInput,
  ) {
    return this.payConversions.requestPay(id, body);
  }

  @Authorize('assignment_history', 'update')
  @Post('people/:id/conversion-requests')
  requestConversion(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(conversionRequestSchema)) body: ConversionRequestInput,
  ) {
    return this.payConversions.requestConversion(id, body);
  }
}

/** Daily at 05:30 IST, before the other sweeps: conversions whose day has come (decision #64). */
@Injectable()
class ScheduledChangesJob implements OnModuleInit {
  constructor(
    @Inject(ScheduledJobs) private readonly jobs: ScheduledJobs,
    @Inject(PayConversionsService) private readonly payConversions: PayConversionsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: 'scheduled-changes',
      cron: '30 5 * * *',
      run: () =>
        runWithContext({ tenantId: this.config.TENANT_ID }, () =>
          this.payConversions.runScheduled(),
        ),
    });
  }
}

@Module({
  imports: [LettersModule],
  controllers: [ChangesController],
  providers: [ChangesService, PayConversionsService, ScheduledChangesJob],
})
export class ChangesModule {}
