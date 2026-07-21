/**
 * Reviewed leakage baseline: exact path + category + lineDigest fingerprints only.
 * Never path wildcards, never raw secret text.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { type LeakageBaseline, leakageBaselineSchema } from './schemas';

export const LEAKAGE_BASELINE_RELATIVE_PATH =
  'scripts/enterprise/security-acceptance/leakage-baseline.json' as const;

export interface BaselineFingerprint {
  category: string;
  lineDigest: string;
  path: string;
}

export const fingerprintKey = (entry: BaselineFingerprint): string =>
  `${entry.path}\u0000${entry.category}\u0000${entry.lineDigest}`;

export const loadLeakageBaseline = async (repoRoot: string): Promise<LeakageBaseline> => {
  const absolute = path.join(repoRoot, LEAKAGE_BASELINE_RELATIVE_PATH);
  const raw = await readFile(absolute, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  return leakageBaselineSchema.parse(parsed);
};

export const tryLoadLeakageBaseline = async (
  repoRoot: string,
): Promise<{ baseline: LeakageBaseline } | { error: string }> => {
  try {
    return { baseline: await loadLeakageBaseline(repoRoot) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'baseline-load-failed';
    if (message.includes('ENOENT') || message.includes('no such file')) {
      return { error: 'baseline-missing' };
    }
    return { error: 'baseline-malformed' };
  }
};

export const buildBaselineIndex = (baseline: LeakageBaseline): Set<string> => {
  const index = new Set<string>();
  for (const entry of baseline.entries) {
    const key = fingerprintKey(entry);
    if (index.has(key)) {
      throw new Error('duplicate baseline fingerprint');
    }
    index.add(key);
  }
  if (index.size !== baseline.entries.length) {
    throw new Error('duplicate baseline fingerprint');
  }
  return index;
};

/** Compare two baseline documents for deterministic regeneration (stable sort + exact set). */
export const baselinesEqual = (a: LeakageBaseline, b: LeakageBaseline): boolean => {
  if (a.schemaVersion !== b.schemaVersion) return false;
  if (a.entries.length !== b.entries.length) return false;
  for (let i = 0; i < a.entries.length; i += 1) {
    const left = a.entries[i]!;
    const right = b.entries[i]!;
    if (
      left.path !== right.path ||
      left.category !== right.category ||
      left.lineDigest !== right.lineDigest
    ) {
      return false;
    }
  }
  return true;
};

export const isBaselinedFinding = (index: Set<string>, finding: BaselineFingerprint): boolean =>
  index.has(fingerprintKey(finding));

/**
 * Deterministic baseline document builder (for generate-baseline CLI).
 * Sorts entries by path, category, lineDigest for stable commits.
 */
export const buildBaselineDocument = (findings: BaselineFingerprint[]): LeakageBaseline => {
  const unique = new Map<string, BaselineFingerprint>();
  for (const finding of findings) {
    unique.set(fingerprintKey(finding), {
      category: finding.category,
      lineDigest: finding.lineDigest,
      path: finding.path,
    });
  }
  const entries = [...unique.values()].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    if (a.lineDigest !== b.lineDigest) return a.lineDigest < b.lineDigest ? -1 : 1;
    return 0;
  });
  return leakageBaselineSchema.parse({
    entries,
    schemaVersion: 1,
  });
};
