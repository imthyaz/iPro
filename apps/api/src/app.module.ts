import { Module } from '@nestjs/common';
import { ConfigModule } from './config.module.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { JobsModule } from './jobs/jobs.module.js';

@Module({
  imports: [ConfigModule, DbModule, JobsModule, HealthModule],
})
export class AppModule {}
