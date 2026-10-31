import { defineConfig } from 'vitest/config';

// CDK synthesis is slow on a cold start.
export default defineConfig({ test: { testTimeout: 30_000 } });
