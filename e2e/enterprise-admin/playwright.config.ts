import { defineConfig } from '@playwright/test';

/**
 * Suite-local Playwright config for enterprise-admin E2E.
 * Not referenced by shared GitHub workflows in this batch (see CI.md).
 */
export default defineConfig({
  expect: { timeout: 20_000 },
  fullyParallel: false,
  outputDir: 'reports/test-artifacts',
  reporter: [
    ['list'],
    ['json', { outputFile: 'reports/results.json' }],
    ['html', { open: 'never', outputFolder: 'reports/html' }],
  ],
  retries: 0,
  testDir: './specs',
  testMatch: '**/*.spec.ts',
  timeout: 240_000,
  use: {
    actionTimeout: 60_000,
    headless: process.env.HEADLESS !== 'false',
    navigationTimeout: 90_000,
    screenshot: 'only-on-failure',
    // Avoid traces that can capture session cookies in CI artifacts.
    trace: 'off',
    video: 'off',
  },
  workers: 1,
});
