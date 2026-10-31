import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { healthResponseSchema } from '@ipro/shared';
import { PgBoss } from 'pg-boss';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG, loadConfig } from '../src/config.js';
import { JOBS } from '../src/jobs/jobs.module.js';
import { TEST_DATABASE_URL } from './test-db.js';

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(loadConfig({ DATABASE_URL: TEST_DATABASE_URL, NODE_ENV: 'test' }))
    .compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
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
