/**
 * Q04 enterprise-admin E2E adapter: Playwright results.json + screenshot digests.
 * Expected: 6/6 tests, zero skip/fail/flaky, 9 exact screenshot digests when full matrix present.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { AdaptedGateEvidence } from './types';

const playwrightJsonSchema = z
  .object({
    suites: z.array(z.unknown()).optional(),
    stats: z
      .object({
        expected: z.number().int().nonnegative().optional(),
        flaky: z.number().int().nonnegative().optional(),
        skipped: z.number().int().nonnegative().optional(),
        unexpected: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Expected critical-path test count for enterprise-admin suite. */
export const EXPECTED_E2E_TEST_COUNT = 6;
/** Evidence matrix: light/dark × desktop/mobile = 4, plus other screenshots may apply; full suite target 9. */
export const EXPECTED_SCREENSHOT_COUNT = 9;

export const adaptEnterpriseAdminE2e = async (input: {
  candidateSha: string;
  resultsJsonPath: string;
  screenshotsDir?: string;
  cleanupResult?: 'failed' | 'passed';
}): Promise<AdaptedGateEvidence> => {
  const raw = await readFile(input.resultsJsonPath, 'utf8');
  const resultsDigest = createHash('sha256').update(raw).digest('hex');
  const parsedJson: unknown = JSON.parse(raw);
  playwrightJsonSchema.parse(parsedJson);

  // Walk Playwright JSON for test outcomes (structure varies by version).
  const counts = countPlaywrightTests(parsedJson);

  const screenshotDigests: string[] = [];
  if (input.screenshotsDir) {
    const files = (await readdir(input.screenshotsDir))
      .filter((name) => name.endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, 'en'));
    for (const name of files) {
      const buf = await readFile(path.join(input.screenshotsDir, name));
      // Non-blank PNG check
      if (buf.length < 8_000) {
        throw new Error(`screenshot too small (likely blank): ${name}`);
      }
      screenshotDigests.push(createHash('sha256').update(buf).digest('hex'));
    }
  }

  const cleanupOk = input.cleanupResult !== 'failed';
  const allPass =
    counts.total === EXPECTED_E2E_TEST_COUNT &&
    counts.passed === EXPECTED_E2E_TEST_COUNT &&
    counts.failed === 0 &&
    counts.skipped === 0 &&
    counts.flaky === 0 &&
    screenshotDigests.length === EXPECTED_SCREENSHOT_COUNT &&
    cleanupOk;

  const status = allPass
    ? ('passed' as const)
    : counts.failed > 0
      ? ('failed' as const)
      : ('unverified' as const);

  const artifactSha256 = createHash('sha256')
    .update([resultsDigest, ...screenshotDigests].join('\n'))
    .digest('hex');

  // Prefer results file mtime as generatedAt bound to artifact existence.
  const st = await stat(input.resultsJsonPath);
  const generatedAt = st.mtime.toISOString();

  return {
    artifactSha256,
    assertions: {
      failed: counts.failed,
      passed: counts.passed,
      skipped: counts.skipped + counts.flaky,
      total: counts.total,
    },
    candidateSha: input.candidateSha,
    details: {
      screenshotCount: screenshotDigests.length,
      flaky: counts.flaky,
    },
    gate: 'enterprise-admin-e2e',
    generatedAt,
    harnessScope: 'local-harness',
    rawArtifactPaths: [input.resultsJsonPath],
    status,
  };
};

const countPlaywrightTests = (
  root: unknown,
): { failed: number; flaky: number; passed: number; skipped: number; total: number } => {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let flaky = 0;

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.suites)) {
      for (const suite of record.suites) visit(suite);
    }
    if (Array.isArray(record.specs)) {
      for (const spec of record.specs) visit(spec);
    }
    if (Array.isArray(record.tests)) {
      for (const test of record.tests) {
        const t = test as { results?: Array<{ status?: string }>; outcome?: string };
        const outcomes = (t.results ?? []).map((r) => r.status);
        if (outcomes.includes('flaky') || t.outcome === 'flaky') {
          flaky += 1;
        } else if (outcomes.includes('failed') || t.outcome === 'unexpected') {
          failed += 1;
        } else if (
          outcomes.includes('skipped') ||
          outcomes.includes('pending') ||
          t.outcome === 'skipped'
        ) {
          skipped += 1;
        } else if (
          (outcomes.includes('passed') || t.outcome === 'expected' || outcomes.length === 0) && // Prefer explicit passed
          (outcomes.includes('passed') || t.outcome === 'expected')
        )
          passed += 1;
      }
    }
    // stats shortcut
    if (record.stats && typeof record.stats === 'object') {
      const stats = record.stats as Record<string, number>;
      if (typeof stats.expected === 'number' && passed === 0 && failed === 0) {
        passed = stats.expected ?? 0;
        failed = stats.unexpected ?? 0;
        skipped = stats.skipped ?? 0;
        flaky = stats.flaky ?? 0;
      }
    }
  };

  visit(root);
  const total = passed + failed + skipped + flaky;
  return { failed, flaky, passed, skipped, total };
};
