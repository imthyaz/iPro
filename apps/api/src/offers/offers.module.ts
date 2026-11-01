import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runWithContext } from '../context/request-context.js';
import {
  FakeGuestInvites,
  GraphGuestInvites,
  GUEST_INVITES,
  type GuestInvites,
} from '../invites/guest-invites.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { LettersModule } from '../letters/letters.module.js';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { OffersController, OnboardingController } from './offers.controller.js';
import { OffersService } from './offers.service.js';
import { OnboardingService } from './onboarding.service.js';

/** Daily at 06:15 IST, offers past their expiry date count as declined (decision #54); invitation retries. */
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
    // Pre-joiner invitations that failed are retried every 30 minutes (decision #55).
    this.jobs.register({
      name: 'prejoiner-invites',
      cron: '*/30 * * * *',
      run: () =>
        runWithContext({ tenantId: this.config.TENANT_ID }, () => this.offers.retryInvites()),
    });
  }
}

@Module({
  imports: [LettersModule, AttendanceModule],
  controllers: [OffersController, OnboardingController],
  providers: [
    OffersService,
    OnboardingService,
    OfferExpiryJob,
    {
      provide: GUEST_INVITES,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): GuestInvites =>
        config.INVITES_PROVIDER === 'graph'
          ? new GraphGuestInvites({
              tenantId: config.ENTRA_TENANT_ID!,
              clientId: config.GRAPH_CLIENT_ID!,
              clientSecret: config.GRAPH_CLIENT_SECRET!,
              groupId: config.PREJOINER_GROUP_ID!,
              redirectUrl: config.APP_URL,
            })
          : new FakeGuestInvites(),
    },
  ],
  exports: [OffersService],
})
export class OffersModule {}
