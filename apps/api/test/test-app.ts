import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG, loadConfig } from '../src/config.js';
import { configureApp } from '../src/security/http-hardening.js';
import { testEnv } from './test-db.js';

/** The real app against the test database, configured like main.ts. */
export async function createTestApp(
  env: Record<string, string> = {},
  /** Providers to replace, e.g. a fake OIDC exchange for Entra sign-in. */
  overrides: { provide: symbol; useValue: unknown }[] = [],
): Promise<INestApplication> {
  const config = loadConfig({ ...testEnv, ...env });
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config);
  for (const override of overrides) {
    builder = builder.overrideProvider(override.provide).useValue(override.useValue);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app, config);
  await app.init();
  return app;
}
