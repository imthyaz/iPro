import { defineConfig, devices } from '@playwright/test';

// Runs against built output: the API from dist and the web app via `vite preview` (which proxies /api).
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
      command: 'pnpm --filter @ipro/api start',
      url: 'http://localhost:3000/api/health/live',
      reuseExistingServer: !process.env.CI,
      // No object store in CI: documents and policies live in memory for the run.
      env: { JOBS_ENABLED: 'false', STORAGE_PROVIDER: 'memory' },
    },
    {
      command: 'pnpm preview',
      url: 'http://localhost:4173',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
