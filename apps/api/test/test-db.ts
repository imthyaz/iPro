import { randomBytes } from 'node:crypto';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://ipro:ipro@localhost:5432/ipro_test';

/** Two synthetic tenants, created by global-setup, for isolation tests. */
export const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
export const TENANT_B = '00000000-0000-4000-8000-0000000000b1';

export const testEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  TENANT_ID: TENANT_A,
  JOBS_ENABLED: 'false',
  LOCAL_FIELD_KEY: randomBytes(32).toString('base64'),
  STORAGE_PROVIDER: 'memory',
};
