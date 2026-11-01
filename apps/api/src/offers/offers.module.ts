import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runWithContext } from '../context/request-context.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { LettersModule } from '../letters/letters.module.js';
import { OffersController } from './offers.controller.js';
import { OffersService } from './offers.service.js';

/** Daily at 06:15 IST, offers past their expiry date count as declined (decision #54). */
@Injectable()
class OfferExpiryJob implements OnModuleInit {
  constructor(
    @Inject(ScheduledJobs) private readonly jobs: ScheduledJobs,
    @Inject(OffersService) private readonly offers: OffersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: 'offer-expiry',
      cron: '15 6 * * *',
      run: () => runWithContext({ tenantId: this.config.TENANT_ID }, () => this.offers.expireDue()),
    });
  }
}

@Module({
  imports: [LettersModule],
  controllers: [OffersController],
  providers: [OffersService, OfferExpiryJob],
  exports: [OffersService],
})
export class OffersModule {}
