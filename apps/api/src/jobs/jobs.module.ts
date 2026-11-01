import {
  Controller,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { Authorize } from '../authz/decorators.js';
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

/**
 * Development and test only: runs a scheduled job now (e.g. the probation sweep, so end-to-end tests
 * and local checks needn't wait for 06:00). The jobs are idempotent; production has no such route.
 */
@Controller('jobs')
export class JobsController {
  constructor(
    @Inject(ScheduledJobs) private readonly jobs: ScheduledJobs,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Authorize('org_config', 'update')
  @Post(':name/run')
  async run(@Param('name') name: string) {
    const job = this.jobs.jobs.find((j) => j.name === name);
    if (this.config.NODE_ENV === 'production' || !job) throw new NotFoundException();
    return { name, result: (await job.run()) ?? null };
  }
}

@Global()
@Module({
  controllers: [JobsController],
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
