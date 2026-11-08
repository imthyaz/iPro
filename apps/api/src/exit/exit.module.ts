import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { runWithContext } from '../context/request-context.js';
import { ScheduledJobs } from '../jobs/jobs.module.js';
import { LettersModule } from '../letters/letters.module.js';
import {
  DIRECTORY_ACCOUNTS,
  FakeDirectoryAccounts,
  GraphDirectoryAccounts,
  NoDirectoryAccounts,
  type DirectoryAccounts,
} from './directory-accounts.js';
import { ExitController } from './exit.controller.js';
import { ExitService } from './exit.service.js';

/**
 * Spec: access disabled at the end of the last working day (decision #82). 23:55 IST daily; a day
 * missed is caught up by the next run.
 */
@Injectable()
class ExitJobs implements OnModuleInit {
  constructor(
    @Inject(ScheduledJobs) private readonly jobs: ScheduledJobs,
    @Inject(ExitService) private readonly exits: ExitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: 'exit-access',
      cron: '55 23 * * *',
      run: () =>
        runWithContext({ tenantId: this.config.TENANT_ID }, () => this.exits.disableDueAccounts()),
    });
  }
}

/** Exit (slice 9; spec workflow 7). */
@Module({
  imports: [LettersModule],
  controllers: [ExitController],
  providers: [
    ExitService,
    ExitJobs,
    {
      provide: DIRECTORY_ACCOUNTS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): DirectoryAccounts =>
        config.DIRECTORY_PROVIDER === 'graph'
          ? new GraphDirectoryAccounts({
              tenantId: config.ENTRA_TENANT_ID!,
              clientId: config.GRAPH_CLIENT_ID!,
              clientSecret: config.GRAPH_CLIENT_SECRET!,
            })
          : config.DIRECTORY_PROVIDER === 'none'
            ? new NoDirectoryAccounts()
            : new FakeDirectoryAccounts(),
    },
  ],
  exports: [ExitService],
})
export class ExitModule {}
