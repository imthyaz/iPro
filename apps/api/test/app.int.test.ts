import type { INestApplication } from '@nestjs/common';
import { healthResponseSchema } from '@ipro/shared';
import { PgBoss } from 'pg-boss';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOBS } from '../src/jobs/jobs.module.js';
import { createTestApp } from './test-app.js';

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp({ JOBS_ENABLED: 'true' });
});

afterAll(() => app.close());

describe('API against a real database', () => {
  it('GET /api/health returns 200 ok', async () => {
    const response = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(healthResponseSchema.parse(response.body)).toMatchObject({
      status: 'ok',
      checks: { database: 'ok' },
    });
  });

  it('starts pg-boss and round-trips a job', async () => {
    const boss = app.get<PgBoss>(JOBS);
    await boss.createQueue('slice0-smoke');
    const id = await boss.send('slice0-smoke', { ping: 1 });
    const [job] = await boss.fetch<{ ping: number }>('slice0-smoke');
    expect(job?.id).toBe(id);
    expect(job?.data.ping).toBe(1);
  });
});
