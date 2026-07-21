/**
 * Enterprise secret/log/trace/audit leakage regression scan.
 * Reports only path / category / line / lineDigest — never matched secret text.
 */
import { createReadStream } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { containsEnterpriseSecretMaterial } from '../../../packages/database/src/models/platform/redact';
import {
  LEAKAGE_SCAN_EXTENSIONS,
  LEAKAGE_SCAN_ROOTS,
  MAX_LEAKAGE_FILE_BYTES,
  SECURITY_ACCEPTANCE_SCHEMA_VERSION,
} from './constants';
import { isLeakageAllowlisted } from './leakageAllowlist';
import { digestLine } from './privacy';
import type { LeakageScanArtifact } from './schemas';

export interface LeakageScanOptions {
  cwd: string;
  /** Override roots (tests). */
  roots?: readonly string[];
}

export type LeakageCategory =
  | 'aws-access-key'
  | 'connection-string'
  | 'credential-assignment'
  | 'generic-secret-material'
  | 'pem-private-key'
  | 'token-or-api-key';

const classifyLine = (line: string): LeakageCategory => {
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

const shouldScanFile = (relativePath: string, size: number): boolean => {
  if (size > MAX_LEAKAGE_FILE_BYTES) return false;
  if (relativePath.includes('node_modules/')) return false;
  if (relativePath.includes('/dist/')) return false;
  const ext = path.extname(relativePath).toLowerCase();
  if (ext && LEAKAGE_SCAN_EXTENSIONS.has(ext)) return true;
  // extensionless config samples under enterprise roots
  const base = path.basename(relativePath);
  return base.startsWith('.env') || base.endsWith('rc') || base.includes('Dockerfile');
};

const walkFiles = async (rootAbs: string, repoRoot: string): Promise<string[]> => {
  const results: string[] = [];
  const stack = [rootAbs];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === 'coverage' ||
          entry.name === '.git'
        ) {
          continue;
        }
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(repoRoot, abs).replaceAll('\\', '/');
      results.push(relative);
    }
  }
  return results;
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

/**
 * Scan enterprise-owned surfaces for secret-shaped material.
 * Allowlisted fixture paths count as allowlistedMatches and do not fail the check.
 */
export const runLeakageScan = async (options: LeakageScanOptions): Promise<LeakageScanArtifact> => {
  const roots = options.roots ?? LEAKAGE_SCAN_ROOTS;
  const findings: LeakageScanArtifact['findings'] = [];
  let filesScanned = 0;
  let allowlistedMatches = 0;

  for (const root of roots) {
    const rootAbs = path.join(options.cwd, root);
    try {
      await access(rootAbs);
    } catch {
      // Missing optional root is not a pass by itself; continue other roots.
      continue;
    }
    const files = await walkFiles(rootAbs, options.cwd);
    files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    for (const relative of files) {
      const absolute = path.join(options.cwd, relative);
      let st;
      try {
        st = await stat(absolute);
      } catch {
        continue;
      }
      if (!st.isFile() || !shouldScanFile(relative, st.size)) continue;

      filesScanned += 1;
      let fileFindings;
      try {
        fileFindings = await scanFileLines(absolute);
      } catch {
        return {
          allowlistedMatches,
          checkId: 'leakage-scan',
          findings: [],
          filesScanned,
          reason: 'scan-read-failed',
          schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
          status: 'unavailable',
          violationCount: 0,
        };
      }

      if (fileFindings.length === 0) continue;

      if (isLeakageAllowlisted(relative)) {
        allowlistedMatches += fileFindings.length;
        continue;
      }

      for (const finding of fileFindings) {
        findings.push({
          category: finding.category,
          line: finding.line,
          lineDigest: finding.lineDigest,
          path: relative,
        });
      }
    }
  }

  // Cap findings in artifact for report size; still count all as violations.
  const violationCount = findings.length;
  const capped = findings.slice(0, 500);
  const status =
    filesScanned === 0
      ? ('unavailable' as const)
      : violationCount > 0
        ? ('failed' as const)
        : ('passed' as const);

  return {
    allowlistedMatches,
    checkId: 'leakage-scan',
    findings: capped,
    filesScanned,
    reason:
      status === 'unavailable'
        ? 'no-files-scanned'
        : status === 'failed'
          ? 'secret-material-detected'
          : undefined,
    schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
    status,
    violationCount,
  };
};
