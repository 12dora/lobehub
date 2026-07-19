import { defineConfig } from '@playwright/test';

export default defineConfig({
  expect: { timeout: 15_000 },
  fullyParallel: false,
  outputDir: 'reports/identity-provider-artifacts',
  reporter: [['list'], ['json', { outputFile: 'reports/identity-provider-results.json' }]],
  retries: 0,
  testDir: './src/identity-provider',
  testMatch: 'authentikRestart.spec.ts',
  timeout: 900_000,
  use: {
    actionTimeout: 15_000,
    headless: process.env.HEADLESS !== 'false',
    ignoreHTTPSErrors: false,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    // OAuth carries one-time code/state values. Keep this lane HAR/trace-free.
    trace: 'off',
    video: 'off',
  },
  workers: 1,
});
