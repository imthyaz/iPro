import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { APP_CONFIG, type AppConfig } from '../config.js';

export const JOBS = Symbol('JOBS');

/** Starts pg-boss with the app; schedules from the spec's "Scheduled jobs" table are added per module. */
@Injectable()
class JobsLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Jobs');
  private started = false;

  constructor(
    @Inject(JOBS) private readonly boss: PgBoss,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.JOBS_ENABLED) return;
    // Job payloads may hold personal data, so log the error type only.
    this.boss.on('error', (error) => this.logger.error(`pg-boss error: ${error.name}`));
    await this.boss.start();
    this.started = true;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.started) await this.boss.stop({ graceful: true });
  }
}

@Global()
@Module({
  providers: [
    {
      provide: JOBS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new PgBoss({ connectionString: config.DATABASE_URL }),
    },
    JobsLifecycle,
  ],
  exports: [JOBS],
})
export class JobsModule {}
