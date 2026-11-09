import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runWithContext } from '../context/request-context.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { BOT_KEYS, BotFrameworkKeys } from './bot-auth.js';
import {
  BotTeams,
  FakeMail,
  FakeTeams,
  GraphMail,
  MAIL_CHANNEL,
  NoMail,
  NoTeams,
  TEAMS_CHANNEL,
  type MailChannel,
  type TeamsChannel,
} from './channels.js';
import { DeliveryService } from './delivery.service.js';
import { MilestonesService } from './milestones.service.js';
import { TeamsBotController } from './teams-bot.controller.js';
import { TeamsBotService } from './teams-bot.service.js';

/** Delivery every minute; date-driven notices at 09:00 IST (decision #87). */
@Injectable()
class NotifyJobs implements OnModuleInit {
  constructor(
    @Inject(ScheduledJobs) private readonly jobs: ScheduledJobs,
    @Inject(DeliveryService) private readonly delivery: DeliveryService,
    @Inject(MilestonesService) private readonly milestones: MilestonesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: 'notification-delivery',
      cron: '* * * * *',
      run: () => runWithContext({ tenantId: this.config.TENANT_ID }, () => this.delivery.run()),
    });
    this.jobs.register({
      name: 'notification-milestones',
      cron: '0 9 * * *',
      run: () => runWithContext({ tenantId: this.config.TENANT_ID }, () => this.milestones.run()),
    });
  }
}

/** Teams and email delivery, the Teams bot and date-driven notices (slice 11b). */
@Module({
  controllers: [TeamsBotController],
  providers: [
    DeliveryService,
    MilestonesService,
    TeamsBotService,
    NotifyJobs,
    { provide: BOT_KEYS, useFactory: () => new BotFrameworkKeys() },
    {
      provide: TEAMS_CHANNEL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): TeamsChannel =>
        config.TEAMS_PROVIDER === 'bot'
          ? new BotTeams({
              appId: config.TEAMS_BOT_APP_ID!,
              appSecret: config.TEAMS_BOT_APP_SECRET!,
              tenantId: config.ENTRA_TENANT_ID!,
            })
          : config.TEAMS_PROVIDER === 'none'
            ? new NoTeams()
            : new FakeTeams(),
    },
    {
      provide: MAIL_CHANNEL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): MailChannel =>
        config.MAIL_PROVIDER === 'graph'
          ? new GraphMail({
              tenantId: config.ENTRA_TENANT_ID!,
              clientId: config.GRAPH_CLIENT_ID!,
              clientSecret: config.GRAPH_CLIENT_SECRET!,
              from: config.MAIL_FROM!,
            })
          : config.MAIL_PROVIDER === 'none'
            ? new NoMail()
            : new FakeMail(),
    },
  ],
  exports: [DeliveryService, MilestonesService],
})
export class NotifyModule {}
