import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runWithContext } from '../context/request-context.js';
import { ESIGN_PROVIDER, FakeEsign, type EsignProvider } from '../esign/esign.js';
import { ZohoSign } from '../esign/zoho-sign.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { LettersController } from './letters.controller.js';
import { LettersService } from './letters.service.js';

/** Every 15 minutes, check letters out for signature (spec: e-sign; backstop for webhooks). */
@Injectable()
class EsignPollJob implements OnModuleInit {
  constructor(
    @Inject(ScheduledJobs) private readonly jobs: ScheduledJobs,
    @Inject(LettersService) private readonly letters: LettersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: 'esign-poll',
      cron: '*/15 * * * *',
      run: () => runWithContext({ tenantId: this.config.TENANT_ID }, () => this.letters.poll()),
    });
  }
}

@Module({
  controllers: [LettersController],
  providers: [
    LettersService,
    EsignPollJob,
    {
      provide: ESIGN_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): EsignProvider =>
        config.ESIGN_PROVIDER === 'zoho'
          ? new ZohoSign({
              accountsUrl: config.ZOHO_ACCOUNTS_URL,
              signUrl: config.ZOHO_SIGN_URL,
              clientId: config.ZOHO_SIGN_CLIENT_ID!,
              clientSecret: config.ZOHO_SIGN_CLIENT_SECRET!,
              refreshToken: config.ZOHO_SIGN_REFRESH_TOKEN!,
              webhookSecret: config.ZOHO_SIGN_WEBHOOK_SECRET,
              webhookHeader: config.ZOHO_SIGN_WEBHOOK_HEADER,
            })
          : new FakeEsign(),
    },
  ],
  exports: [LettersService, ESIGN_PROVIDER],
})
export class LettersModule {}
