// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  adaptEnterpriseAdminE2e,
  EXPECTED_E2E_TEST_COUNT,
  EXPECTED_SCREENSHOT_COUNT,
} from './enterpriseAdminE2e';

const CANDIDATE = 'a'.repeat(40);
const START_ISO = '2026-04-15T12:34:56.789Z';

/** Minimal Playwright 1.61.x JSON reporter shape (stats.startTime is ISO string). */
const buildPlaywrightResultsJson = () => ({
  candidateSha: CANDIDATE,
  config: { metadata: { candidateSha: CANDIDATE } },
  stats: {
    duration: 12_345,
    expected: EXPECTED_E2E_TEST_COUNT,
    flaky: 0,
    skipped: 0,
    startTime: START_ISO,
    unexpected: 0,
  },
  suites: [
    {
      specs: Array.from({ length: EXPECTED_E2E_TEST_COUNT }, (_, i) => ({
        tests: [
          {
            outcome: 'expected',
            results: [{ status: 'passed' }],
            title: `test-${i + 1}`,
          },
        ],
      })),
      title: 'enterprise-admin',
    },
  ],
});

const pngHeader = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...Array.from({ length: 8_100 }, () => 0x41),
]);

describe('adaptEnterpriseAdminE2e (Playwright JSON)', () => {
  it('reads stats.startTime ISO and passes with six tests + nine screenshots', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'e2e-adapter-'));
    const resultsPath = path.join(dir, 'results.json');
    const shotsDir = path.join(dir, 'screenshots');
    await mkdir(shotsDir, { recursive: true });
    await writeFile(resultsPath, JSON.stringify(buildPlaywrightResultsJson()), 'utf8');
    for (let i = 0; i < EXPECTED_SCREENSHOT_COUNT; i += 1) {
      await writeFile(path.join(shotsDir, `shot-${String(i).padStart(2, '0')}.png`), pngHeader);
    }

    const adapted = await adaptEnterpriseAdminE2e({
      candidateSha: CANDIDATE,
      cleanupResult: 'passed',
      resultsJsonPath: resultsPath,
      screenshotsDir: shotsDir,
    });

    expect(adapted.status).toBe('passed');
    expect(adapted.generatedAt).toBe(new Date(START_ISO).toISOString());
    expect(adapted.assertions).toBeDefined();
    expect(adapted.assertions?.passed).toBe(EXPECTED_E2E_TEST_COUNT);
    expect(adapted.assertions?.failed).toBe(0);
    expect(adapted.assertions?.skipped).toBe(0);
    expect(adapted.assertions?.total).toBe(EXPECTED_E2E_TEST_COUNT);
    expect(adapted.details).toMatchObject({
      flaky: 0,
      screenshotCount: EXPECTED_SCREENSHOT_COUNT,
    });
    // Digests are stable SHA-256 of the identical PNG fixtures.
    const oneDigest = createHash('sha256').update(pngHeader).digest('hex');
    expect(adapted.artifactSha256).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(oneDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
