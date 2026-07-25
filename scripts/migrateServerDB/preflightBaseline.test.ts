// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  evaluateBaselinePreflight,
  PARTIAL_BASELINE_RECOVERY_HINT,
  REQUIRED_BASELINE_EXTENSIONS,
} from './preflightBaseline';

describe('evaluateBaselinePreflight (DB-003)', () => {
  it('fails when a required extension is unavailable', async () => {
    const result = await evaluateBaselinePreflight({
      extensionAvailable: async (name) => name !== 'vector',
      isPartialInstall: async () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.missingExtensions).toEqual(['vector']);
    expect(result.partialInstallDetected).toBe(false);
  });

  it('fails with recovery hint surface when partial install is detected', async () => {
    const result = await evaluateBaselinePreflight({
      extensionAvailable: async () => true,
      isPartialInstall: async () => true,
    });
    expect(result.ok).toBe(false);
    expect(result.partialInstallDetected).toBe(true);
    expect(PARTIAL_BASELINE_RECOVERY_HINT).toMatch(/DROP the database/i);
    expect(PARTIAL_BASELINE_RECOVERY_HINT).toMatch(/DB-003/);
  });

  it('passes when all extensions exist and install is clean', async () => {
    const result = await evaluateBaselinePreflight({
      extensionAvailable: async () => true,
      isPartialInstall: async () => false,
    });
    expect(result).toEqual({
      missingExtensions: [],
      ok: true,
      partialInstallDetected: false,
    });
    expect(REQUIRED_BASELINE_EXTENSIONS).toContain('vector');
  });

  it('requires vector + pg_search only (baseline unguarded extensions)', () => {
    expect([...REQUIRED_BASELINE_EXTENSIONS]).toEqual(['vector', 'pg_search']);
    expect(REQUIRED_BASELINE_EXTENSIONS).not.toContain('uuid-ossp');
    expect(REQUIRED_BASELINE_EXTENSIONS).not.toContain('pgcrypto');
    expect(REQUIRED_BASELINE_EXTENSIONS).not.toContain('pg_trgm');
  });

  it('fails when pg_search is unavailable (post-COMMIT late-failure extension)', async () => {
    const result = await evaluateBaselinePreflight({
      extensionAvailable: async (name) => name !== 'pg_search',
      isPartialInstall: async () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.missingExtensions).toEqual(['pg_search']);
  });

  it('covers every unguarded CREATE EXTENSION after the mid-file COMMIT (late-failure regression)', async () => {
    // Static regression: if the baseline gains another unguarded post-COMMIT extension,
    // preflight must require it or the mid-file COMMIT leaves a partial install.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const baselinePath = join(
      __dirname,
      '../../packages/database/migrations/0000_squash_baseline.sql',
    );
    const sql = readFileSync(baselinePath, 'utf8');
    const commitIdx = sql.search(/^\s*COMMIT\s*;/m);
    expect(commitIdx).toBeGreaterThan(0);
    const afterCommit = sql.slice(commitIdx);
    // Unguarded CREATE EXTENSION (not inside a DO $$ … EXCEPTION block on the same stmt).
    const createExt = [
      ...afterCommit.matchAll(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+["']?(\w+)/gi),
    ].map((m) => m[1]!.toLowerCase());
    // pg_trgm is exception-guarded in baseline — filter those that appear only inside DO blocks
    // by requiring membership in REQUIRED when the create is not wrapped. Heuristic: if the
    // CREATE line is preceded within 40 chars by "EXCEPTION" skip it; otherwise require it.
    const requiredFromBaseline = new Set<string>();
    for (const m of afterCommit.matchAll(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+["']?(\w+)/gi)) {
      const name = m[1]!.toLowerCase();
      const windowStart = Math.max(0, (m.index ?? 0) - 200);
      const preceding = afterCommit.slice(windowStart, m.index ?? 0);
      // Exception-guarded blocks open with DO $$ … BEGIN and catch OTHERS after the create.
      // pg_trgm's create sits inside such a block; pg_search does not.
      if (
        /DO\s+\$\$/i.test(preceding) &&
        !/END\s+\$\$/i.test(preceding.split(/DO\s+\$\$/i).pop()!)
      ) {
        continue;
      }
      requiredFromBaseline.add(name);
    }
    // At minimum the known late-failure extension must be required.
    expect(requiredFromBaseline.has('pg_search') || createExt.includes('pg_search')).toBe(true);
    for (const name of requiredFromBaseline) {
      expect(REQUIRED_BASELINE_EXTENSIONS).toContain(name);
    }
    expect(REQUIRED_BASELINE_EXTENSIONS).toContain('pg_search');
  });
});
