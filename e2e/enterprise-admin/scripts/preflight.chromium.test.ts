import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Empty PLAYWRIGHT_BROWSERS_PATH must fail Chromium launch.
 * Proves preflight cannot false-pass on dry-run alone.
 * Uses mkdtemp + recursive cleanup so no /tmp leftovers remain.
 */
describe('chromium launch preflight contract', () => {
  it('fails when browsers path is empty directory and cleans temp dir', () => {
    const emptyBrowsers = mkdtempSync(path.join(tmpdir(), 'pw-browsers-empty-'));
    try {
      const probe = spawnSync(
        process.execPath,
        [
          '-e',
          `const { chromium } = require('playwright');
           chromium.launch({ headless: true })
             .then(async (b) => { await b.close(); process.exit(0); })
             .catch(() => process.exit(1));`,
        ],
        {
          cwd: path.resolve(__dirname, '../..'),
          encoding: 'utf8',
          env: {
            ...process.env,
            PLAYWRIGHT_BROWSERS_PATH: emptyBrowsers,
          },
          timeout: 30_000,
        },
      );
      expect(probe.status).not.toBe(0);
    } finally {
      rmSync(emptyBrowsers, { force: true, recursive: true });
    }
  }, 45_000);
});
