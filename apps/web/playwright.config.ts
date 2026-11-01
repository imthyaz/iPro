import { defineConfig, devices } from '@playwright/test';

// Runs against built output: the API from dist and the web app via `vite preview` (which proxies /api).
// CI starts from an empty database. Locally the API runs on its own `ipro_e2e` database, rebuilt and
// seeded each run, so earlier runs and your dev data never get in the way.
const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://ipro:ipro@localhost:5432/ipro_e2e';

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: process.env.CI
        ? 'pnpm --filter @ipro/api start'
        : 'node ../api/scripts/reset-e2e-db.mjs && pnpm --filter @ipro/api start',
      url: 'http://localhost:3000/api/health/live',
      // Never a running dev server: it would use the dev database. Stop `pnpm dev` before e2e.
      reuseExistingServer: false,
      timeout: 180_000,
      // No object store in CI: documents and policies live in memory for the run.
      env: {
        JOBS_ENABLED: 'false',
        STORAGE_PROVIDER: 'memory',
        ...(process.env.CI ? {} : { DATABASE_URL: E2E_DATABASE_URL, E2E_DATABASE_URL }),
      },
    },
    {
      command: 'pnpm preview',
      url: 'http://localhost:4173',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
