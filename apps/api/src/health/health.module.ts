import { Module } from '@nestjs/common';
import { DatabaseHealth } from './database-health.js';
import { HealthController } from './health.controller.js';

@Module({
  controllers: [HealthController],
  providers: [DatabaseHealth],
})
export class HealthModule {}
