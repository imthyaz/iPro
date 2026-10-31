import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { HealthResponse } from '@ipro/shared';
import { DatabaseHealth } from './database-health.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(DatabaseHealth) private readonly database: DatabaseHealth) {}

  /** Liveness: the process is up. Used by the load balancer so a database blip doesn't kill tasks. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: 200 when the database is reachable, 503 otherwise. */
  @Get()
  async ready(): Promise<HealthResponse> {
    const databaseUp = await this.database.isUp();
    const body: HealthResponse = {
      status: databaseUp ? 'ok' : 'degraded',
      checks: { database: databaseUp ? 'ok' : 'down' },
      time: new Date().toISOString(),
    };
    if (!databaseUp) throw new ServiceUnavailableException(body);
    return body;
  }
}
