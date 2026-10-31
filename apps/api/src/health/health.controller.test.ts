import { ServiceUnavailableException } from '@nestjs/common';
import { healthResponseSchema } from '@ipro/shared';
import { describe, expect, it } from 'vitest';
import type { DatabaseHealth } from './database-health.js';
import { HealthController } from './health.controller.js';

const fakeDatabase = (up: boolean) => ({ isUp: async () => up }) as DatabaseHealth;

describe('HealthController', () => {
  it('reports ok when the database is reachable', async () => {
    const body = await new HealthController(fakeDatabase(true)).ready();
    expect(healthResponseSchema.parse(body)).toMatchObject({
      status: 'ok',
      checks: { database: 'ok' },
    });
  });

  it('returns 503 with a degraded body when the database is down', async () => {
    const error = await new HealthController(fakeDatabase(false)).ready().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const body = (error as ServiceUnavailableException).getResponse();
    expect(healthResponseSchema.parse(body)).toMatchObject({
      status: 'degraded',
      checks: { database: 'down' },
    });
  });

  it('is live regardless of the database', () => {
    expect(new HealthController(fakeDatabase(false)).live()).toEqual({ status: 'ok' });
  });
});
