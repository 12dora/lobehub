import { defineConfig } from '@playwright/test';

/**
 * Suite-local Playwright config for enterprise-admin E2E.
 * CI scheduling and gate policy are defined in CI.md and
 * .github/workflows/enterprise-admin-gates.yml.
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
