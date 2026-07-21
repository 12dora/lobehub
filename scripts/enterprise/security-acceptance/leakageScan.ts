/**
 * Enterprise secret/log/trace/audit leakage regression scan.
 * Fail-closed coverage: missing roots, symlinks, oversized, unreadable → not pass.
 * Findings report path/category/line/lineDigest only — never matched secret text.
 */
import { createReadStream } from 'node:fs';
import { access, lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { containsEnterpriseSecretMaterial } from '../../../packages/database/src/models/platform/redact';
import {
  LEAKAGE_SCAN_EXTENSIONS,
  LEAKAGE_SCAN_ROOTS,
  MAX_LEAKAGE_FILE_BYTES,
  SECURITY_ACCEPTANCE_SCHEMA_VERSION,
} from './constants';
import { isExactAllowlistedFinding } from './leakageAllowlist';
import {
  type BaselineFingerprint,
  buildBaselineIndex,
  isBaselinedFinding,
  tryLoadLeakageBaseline,
} from './leakageBaseline';
import { digestLine } from './privacy';
import type { LeakageScanArtifact } from './schemas';

export interface LeakageScanOptions {
  /** Inject baseline fingerprints (tests). */
  baselineFindings?: BaselineFingerprint[];
  cwd: string;
  /**
   * When true (default for real repo), require leakage-baseline.json.
   * Tests may inject baselineFindings instead.
   */
  requireBaseline?: boolean;
  /** Override roots (tests). Missing roots always fail closed. */
  roots?: readonly string[];
}

export type LeakageCategory =
  | 'aws-access-key'
  | 'connection-string'
  | 'credential-assignment'
  | 'generic-secret-material'
  | 'pem-private-key'
  | 'token-or-api-key';

export const classifyLine = (line: string): LeakageCategory => {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(line)) return 'pem-private-key';
  if (/\bAKIA[0-9A-Z]{16}\b/u.test(line)) return 'aws-access-key';
  if (/(?:postgres(?:ql)?|mysql|mongodb|rediss?):\/\/[^\s'"]+/iu.test(line)) {
    return 'connection-string';
  }
  if (/(?:password|secret|token|api[_-]?key|client_secret)\s*[:=]\s*\S+/iu.test(line)) {
    return 'credential-assignment';
  }
  if (/sk-proj-|ghp_|xox[baprs]-|eat_(?:live|test)_|Bearer\s+\S+/u.test(line)) {
    return 'token-or-api-key';
  }
  return 'generic-secret-material';
};

const shouldScanExtension = (relativePath: string): boolean => {
  if (relativePath.includes('node_modules/')) return false;
  if (relativePath.includes('/dist/')) return false;
  const ext = path.extname(relativePath).toLowerCase();
  if (ext && LEAKAGE_SCAN_EXTENSIONS.has(ext)) return true;
  const base = path.basename(relativePath);
  return base.startsWith('.env') || base.endsWith('rc') || base.includes('Dockerfile');
};

const isInsideRoot = (absolutePath: string, rootAbs: string): boolean => {
  const normalizedRoot = rootAbs.endsWith(path.sep) ? rootAbs : `${rootAbs}${path.sep}`;
  return absolutePath === rootAbs || absolutePath.startsWith(normalizedRoot);
};

interface WalkCounters {
  oversizedSkipped: number;
  symlinkEncounters: number;
  unreadableFiles: number;
  walkErrors: number;
}

interface WalkResult {
  counters: WalkCounters;
  files: string[];
}

/**
 * Walk without following symlinks. Symlink files/dirs are counted and not scanned.
 * Realpath of each regular file must remain inside the configured root.
 */
const walkFilesSecure = async (rootAbs: string, repoRoot: string): Promise<WalkResult> => {
  const counters: WalkCounters = {
    oversizedSkipped: 0,
    symlinkEncounters: 0,
    unreadableFiles: 0,
    walkErrors: 0,
  };
  const files: string[] = [];
  const stack = [rootAbs];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      counters.walkErrors += 1;
      continue;
    }

    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      let st;
      try {
        st = await lstat(abs);
      } catch {
        counters.unreadableFiles += 1;
        continue;
      }

      if (st.isSymbolicLink()) {
        counters.symlinkEncounters += 1;
        continue;
      }

      if (st.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === 'coverage' ||
          entry.name === '.git'
        ) {
          continue;
        }
        // Ensure directory stays under root (no intermediate escape via rename races).
        if (!isInsideRoot(abs, rootAbs)) {
          counters.walkErrors += 1;
          continue;
        }
        stack.push(abs);
        continue;
      }

      if (!st.isFile()) continue;

      if (!isInsideRoot(abs, rootAbs)) {
        counters.walkErrors += 1;
        continue;
      }

      // Reject if realpath escapes root (hardlink/mount edge cases).
      try {
        const resolved = await realpath(abs);
        if (!isInsideRoot(resolved, await realpath(rootAbs))) {
          counters.symlinkEncounters += 1;
          continue;
        }
      } catch {
        counters.unreadableFiles += 1;
        continue;
      }

      const relative = path.relative(repoRoot, abs).replaceAll('\\', '/');
      if (!shouldScanExtension(relative)) continue;

      if (st.size > MAX_LEAKAGE_FILE_BYTES) {
        counters.oversizedSkipped += 1;
        continue;
      }

      files.push(relative);
    }
  }

  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { counters, files };
};

const scanFileLines = async (
  absolutePath: string,
): Promise<Array<{ category: LeakageCategory; line: number; lineDigest: string }>> => {
  const findings: Array<{ category: LeakageCategory; line: number; lineDigest: string }> = [];
  const stream = createReadStream(absolutePath, { encoding: 'utf8' });
  const rl = createInterface({ crlfDelay: Infinity, input: stream });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;
    if (!containsEnterpriseSecretMaterial(line)) continue;
    findings.push({
      category: classifyLine(line),
      line: lineNumber,
      lineDigest: digestLine(line),
    });
  }
  return findings;
};

const emptyCoverage = (rootsRequired: number) => ({
  baselinedMatches: 0,
  filesScanned: 0,
  oversizedSkipped: 0,
  rootsMissing: 0,
  rootsPresent: 0,
  rootsRequired,
  symlinkEncounters: 0,
  unreadableFiles: 0,
  walkErrors: 0,
});

/**
 * Scan enterprise-owned surfaces for secret-shaped material.
 */
export const runLeakageScan = async (options: LeakageScanOptions): Promise<LeakageScanArtifact> => {
  const roots = options.roots ?? LEAKAGE_SCAN_ROOTS;
  const findings: LeakageScanArtifact['findings'] = [];
  let filesScanned = 0;
  let allowlistedMatches = 0;
  let baselinedMatches = 0;
  let rootsPresent = 0;
  let rootsMissing = 0;
  let symlinkEncounters = 0;
  let oversizedSkipped = 0;
  let unreadableFiles = 0;
  let walkErrors = 0;

  // Resolve baseline index
  let baselineIndex = new Set<string>();
  if (options.baselineFindings) {
    baselineIndex = buildBaselineIndex({
      entries: options.baselineFindings,
      schemaVersion: 1,
    });
  } else if (options.requireBaseline !== false) {
    const loaded = await tryLoadLeakageBaseline(options.cwd);
    if ('error' in loaded) {
      return {
        allowlistedMatches: 0,
        baselinedMatches: 0,
        checkId: 'leakage-scan',
        coverage: emptyCoverage(roots.length),
        findings: [],
        filesScanned: 0,
        reason: loaded.error,
        schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
        status: 'unavailable',
        violationCount: 0,
      };
    }
    baselineIndex = buildBaselineIndex(loaded.baseline);
  }

  for (const root of roots) {
    const rootAbs = path.join(options.cwd, root);
    try {
      await access(rootAbs);
      const rootStat = await lstat(rootAbs);
      if (rootStat.isSymbolicLink()) {
        symlinkEncounters += 1;
        rootsMissing += 1;
        continue;
      }
      if (!rootStat.isDirectory()) {
        walkErrors += 1;
        rootsMissing += 1;
        continue;
      }
    } catch {
      rootsMissing += 1;
      continue;
    }
    rootsPresent += 1;

    const walked = await walkFilesSecure(rootAbs, options.cwd);
    symlinkEncounters += walked.counters.symlinkEncounters;
    oversizedSkipped += walked.counters.oversizedSkipped;
    unreadableFiles += walked.counters.unreadableFiles;
    walkErrors += walked.counters.walkErrors;

    for (const relative of walked.files) {
      const absolute = path.join(options.cwd, relative);
      let st;
      try {
        st = await stat(absolute);
      } catch {
        unreadableFiles += 1;
        continue;
      }
      if (!st.isFile()) continue;

      filesScanned += 1;
      let fileFindings;
      try {
        fileFindings = await scanFileLines(absolute);
      } catch {
        return {
          allowlistedMatches,
          baselinedMatches,
          checkId: 'leakage-scan',
          coverage: {
            baselinedMatches,
            filesScanned,
            oversizedSkipped,
            rootsMissing,
            rootsPresent,
            rootsRequired: roots.length,
            symlinkEncounters,
            unreadableFiles: unreadableFiles + 1,
            walkErrors,
          },
          findings: [],
          filesScanned,
          reason: 'scan-read-failed',
          schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
          status: 'unavailable',
          violationCount: 0,
        };
      }

      for (const finding of fileFindings) {
        const fingerprint: BaselineFingerprint = {
          category: finding.category,
          lineDigest: finding.lineDigest,
          path: relative,
        };
        if (isExactAllowlistedFinding(fingerprint)) {
          allowlistedMatches += 1;
          continue;
        }
        if (isBaselinedFinding(baselineIndex, fingerprint)) {
          baselinedMatches += 1;
          continue;
        }
        findings.push({
          category: finding.category,
          line: finding.line,
          lineDigest: finding.lineDigest,
          path: relative,
        });
      }
    }
  }

  const violationCount = findings.length;
  const capped = findings.slice(0, 500);
  const coverage = {
    baselinedMatches,
    filesScanned,
    oversizedSkipped,
    rootsMissing,
    rootsPresent,
    rootsRequired: roots.length,
    symlinkEncounters,
    unreadableFiles,
    walkErrors,
  };

  // Fail-closed coverage gates (never pass).
  if (rootsMissing > 0) {
    return {
      allowlistedMatches,
      baselinedMatches,
      checkId: 'leakage-scan',
      coverage,
      findings: capped,
      filesScanned,
      reason: 'missing-required-root',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'unavailable',
      violationCount,
    };
  }
  if (symlinkEncounters > 0) {
    return {
      allowlistedMatches,
      baselinedMatches,
      checkId: 'leakage-scan',
      coverage,
      findings: capped,
      filesScanned,
      reason: 'symlink-encountered',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'failed',
      violationCount,
    };
  }
  if (oversizedSkipped > 0) {
    return {
      allowlistedMatches,
      baselinedMatches,
      checkId: 'leakage-scan',
      coverage,
      findings: capped,
      filesScanned,
      reason: 'oversized-files-present',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'failed',
      violationCount,
    };
  }
  if (unreadableFiles > 0 || walkErrors > 0) {
    return {
      allowlistedMatches,
      baselinedMatches,
      checkId: 'leakage-scan',
      coverage,
      findings: capped,
      filesScanned,
      reason: 'walk-incomplete',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'unavailable',
      violationCount,
    };
  }
  if (filesScanned === 0) {
    return {
      allowlistedMatches,
      baselinedMatches,
      checkId: 'leakage-scan',
      coverage,
      findings: [],
      filesScanned: 0,
      reason: 'no-files-scanned',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'unavailable',
      violationCount: 0,
    };
  }
  if (violationCount > 0) {
    return {
      allowlistedMatches,
      baselinedMatches,
      checkId: 'leakage-scan',
      coverage,
      findings: capped,
      filesScanned,
      reason: 'secret-material-detected',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'failed',
      violationCount,
    };
  }

  return {
    allowlistedMatches,
    baselinedMatches,
    checkId: 'leakage-scan',
    coverage,
    findings: [],
    filesScanned,
    schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
    status: 'passed',
    violationCount: 0,
  };
};

/**
 * Collect all raw findings (including baselinable) for baseline generation.
 * Still rejects secret text from output — only fingerprints.
 */
export const collectLeakageFingerprints = async (options: {
  cwd: string;
  roots?: readonly string[];
}): Promise<BaselineFingerprint[]> => {
  const roots = options.roots ?? LEAKAGE_SCAN_ROOTS;
  const collected: BaselineFingerprint[] = [];

  for (const root of roots) {
    const rootAbs = path.join(options.cwd, root);
    try {
      await access(rootAbs);
    } catch {
      continue;
    }
    const walked = await walkFilesSecure(rootAbs, options.cwd);
    for (const relative of walked.files) {
      const absolute = path.join(options.cwd, relative);
      try {
        const fileFindings = await scanFileLines(absolute);
        for (const finding of fileFindings) {
          collected.push({
            category: finding.category,
            lineDigest: finding.lineDigest,
            path: relative,
          });
        }
      } catch {
        // skip unreadable during generation; generator should surface incomplete walks
      }
    }
  }
  return collected;
};
