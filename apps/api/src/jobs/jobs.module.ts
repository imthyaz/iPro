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

export interface ScheduledJob {
  name: string;
  /** Cron in India time (Asia/Kolkata), e.g. '30 6 * * *' for 06:30 daily. */
  cron: string;
  run: () => Promise<unknown>;
}

/** Modules register their scheduled jobs (spec: Scheduled jobs) at start-up; they start with pg-boss. */
@Injectable()
export class ScheduledJobs {
  readonly jobs: ScheduledJob[] = [];

  register(job: ScheduledJob): void {
    this.jobs.push(job);
  }
}

/** Starts pg-boss with the app, then schedules and works every registered job. */
@Injectable()
class JobsLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Jobs');
  private started = false;

  constructor(
    @Inject(JOBS) private readonly boss: PgBoss,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ScheduledJobs) private readonly scheduled: ScheduledJobs,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.JOBS_ENABLED) return;
    // Job payloads may hold personal data, so log the error type only.
    this.boss.on('error', (error) => this.logger.error(`pg-boss error: ${error.name}`));
    await this.boss.start();
    this.started = true;
    for (const job of this.scheduled.jobs) {
      await this.boss.createQueue(job.name);
      await this.boss.schedule(job.name, job.cron, null, { tz: 'Asia/Kolkata' });
      await this.boss.work(job.name, async () => {
        await job.run();
      });
    }
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
    ScheduledJobs,
    JobsLifecycle,
  ],
  exports: [JOBS, ScheduledJobs],
})
export class JobsModule {}
