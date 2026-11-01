import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG, loadConfig } from '../src/config.js';
import { testEnv } from './test-db.js';

/** The real app against the test database, configured like main.ts. */
export async function createTestApp(
  env: Record<string, string> = {},
  /** Providers to replace, e.g. a fake OIDC exchange for Entra sign-in. */
  overrides: { provide: symbol; useValue: unknown }[] = [],
): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(loadConfig({ ...testEnv, ...env }));
  for (const override of overrides) {
    builder = builder.overrideProvider(override.provide).useValue(override.useValue);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('api');
  await app.init();
  return app;
}
