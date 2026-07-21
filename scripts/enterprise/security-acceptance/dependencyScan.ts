/**
 * Production dependency vulnerability scan via pnpm audit (real supported scanner).
 * Network/tool/lockfile unavailability → unavailable (never pass).
 */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEPENDENCY_FAIL_SEVERITIES,
  DEPENDENCY_SCANNER_ARGV,
  DEPENDENCY_SCANNER_ID,
  SECURITY_ACCEPTANCE_SCHEMA_VERSION,
} from './constants';
import { omitUndefinedDeep } from './omitUndefined';
import { sha256Hex } from './privacy';
import { extractFirstJsonObject, type ProcessRunner, runProcess } from './process';
import type { DependencyScanArtifact } from './schemas';

const artifact = (value: DependencyScanArtifact): DependencyScanArtifact =>
  omitUndefinedDeep(value);

export interface DependencyScanOptions {
  /** When true, attempt `pnpm install --lockfile-only` if lockfile is missing. */
  allowGenerateLockfile?: boolean;
  cwd: string;
  runProcess?: ProcessRunner;
  timeoutMs?: number;
}

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const resolveToolVersion = async (
  runner: ProcessRunner,
  cwd: string,
): Promise<string | undefined> => {
  try {
    const result = await runner(['pnpm', '--version'], { cwd, timeoutMs: 30_000 });
    if (result.timedOut || result.code !== 0) return undefined;
    const version = result.stdout.trim().split(/\s+/u)[0] ?? '';
    if (!/^[\w.+-]+$/u.test(version)) return undefined;
    return version;
  } catch {
    return undefined;
  }
};

/**
 * Parse pnpm audit --json payload. Malformed → throw (caller maps to unavailable/failed).
 */
export const parsePnpmAuditJson = (
  payload: unknown,
): {
  policyHits: number;
  severityCounts: {
    critical: number;
    high: number;
    info: number;
    low: number;
    moderate: number;
  };
} => {
  if (!payload || typeof payload !== 'object') {
    throw new Error('malformed-audit-output');
  }
  const record = payload as Record<string, unknown>;
  if (record.error && typeof record.error === 'object') {
    throw new Error('audit-tool-error');
  }

  const metadata = record.metadata;
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('malformed-audit-metadata');
  }
  const vulnerabilities = (metadata as Record<string, unknown>).vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== 'object') {
    throw new Error('malformed-audit-vulnerabilities');
  }
  const counts = vulnerabilities as Record<string, unknown>;
  const severityCounts = {
    critical: Number(counts.critical ?? 0),
    high: Number(counts.high ?? 0),
    info: Number(counts.info ?? 0),
    low: Number(counts.low ?? 0),
    moderate: Number(counts.moderate ?? 0),
  };
  for (const [key, value] of Object.entries(severityCounts)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`malformed-severity-${key}`);
    }
  }

  let policyHits = 0;
  for (const severity of DEPENDENCY_FAIL_SEVERITIES) {
    policyHits += severityCounts[severity];
  }

  return { policyHits, severityCounts };
};

const ensureLockfile = async (
  cwd: string,
  runner: ProcessRunner,
  allowGenerate: boolean,
): Promise<{ kind: 'pnpm-lock'; path: string; sha256: string } | { reason: string }> => {
  const lockPath = path.join(cwd, 'pnpm-lock.yaml');
  if (await fileExists(lockPath)) {
    const bytes = await readFile(lockPath);
    return { kind: 'pnpm-lock', path: 'pnpm-lock.yaml', sha256: sha256Hex(bytes) };
  }

  if (!allowGenerate) {
    return { reason: 'lockfile-missing' };
  }

  try {
    const generated = await runner(
      ['pnpm', 'install', '--lockfile-only', '--config.lockfile=true'],
      { cwd, timeoutMs: 15 * 60 * 1000 },
    );
    if (generated.timedOut || generated.code !== 0 || !(await fileExists(lockPath))) {
      return { reason: 'lockfile-generate-failed' };
    }
    const bytes = await readFile(lockPath);
    return { kind: 'pnpm-lock', path: 'pnpm-lock.yaml', sha256: sha256Hex(bytes) };
  } catch {
    return { reason: 'lockfile-generate-unavailable' };
  }
};

/**
 * Run production dependency scan. Fail-closed on high/critical and on tool unavailability.
 */
export const runDependencyScan = async (
  options: DependencyScanOptions,
): Promise<DependencyScanArtifact> => {
  const runner = options.runProcess ?? runProcess;
  const packageJsonPath = path.join(options.cwd, 'package.json');

  if (!(await fileExists(packageJsonPath))) {
    return artifact({
      checkId: 'dependency-scan',
      failSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
      policyHits: 0,
      reason: 'package-json-missing',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'unavailable',
      target: { kind: 'package-json', path: 'package.json' },
      tool: { id: DEPENDENCY_SCANNER_ID, version: 'unknown' },
    });
  }

  const packageJsonSha256 = sha256Hex(await readFile(packageJsonPath));
  const toolVersion = (await resolveToolVersion(runner, options.cwd)) ?? 'unknown';

  if (toolVersion === 'unknown') {
    return artifact({
      checkId: 'dependency-scan',
      failSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
      policyHits: 0,
      reason: 'scanner-unavailable',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'unavailable',
      target: {
        kind: 'package-json',
        packageJsonSha256,
        path: 'package.json',
      },
      tool: { id: DEPENDENCY_SCANNER_ID, version: 'unknown' },
    });
  }

  const lockfile = await ensureLockfile(options.cwd, runner, options.allowGenerateLockfile ?? true);
  if ('reason' in lockfile) {
    return artifact({
      checkId: 'dependency-scan',
      failSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
      policyHits: 0,
      reason: lockfile.reason,
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'unavailable',
      target: {
        kind: 'package-json',
        packageJsonSha256,
        path: 'package.json',
      },
      tool: { id: DEPENDENCY_SCANNER_ID, version: toolVersion },
    });
  }

  let processResult;
  try {
    processResult = await runner([...DEPENDENCY_SCANNER_ARGV], {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
    });
  } catch {
    return artifact({
      checkId: 'dependency-scan',
      failSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
      policyHits: 0,
      reason: 'scanner-spawn-failed',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'unavailable',
      target: {
        kind: 'pnpm-lock',
        lockfileSha256: lockfile.sha256,
        packageJsonSha256,
        path: lockfile.path,
      },
      tool: { id: DEPENDENCY_SCANNER_ID, version: toolVersion },
    });
  }

  if (processResult.timedOut) {
    return artifact({
      checkId: 'dependency-scan',
      failSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
      policyHits: 0,
      reason: 'scanner-timeout',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'unavailable',
      target: {
        kind: 'pnpm-lock',
        lockfileSha256: lockfile.sha256,
        packageJsonSha256,
        path: lockfile.path,
      },
      tool: { id: DEPENDENCY_SCANNER_ID, version: toolVersion },
    });
  }

  if (processResult.outputTruncated) {
    return artifact({
      checkId: 'dependency-scan',
      failSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
      policyHits: 0,
      reason: 'scanner-output-truncated',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'unavailable',
      target: {
        kind: 'pnpm-lock',
        lockfileSha256: lockfile.sha256,
        packageJsonSha256,
        path: lockfile.path,
      },
      tool: { id: DEPENDENCY_SCANNER_ID, version: toolVersion },
    });
  }

  const combined = `${processResult.stdout}\n${processResult.stderr}`;
  let parsed: unknown;
  try {
    parsed = extractFirstJsonObject(combined);
  } catch {
    return artifact({
      checkId: 'dependency-scan',
      failSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
      policyHits: 0,
      reason: 'malformed-audit-output',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'unavailable',
      target: {
        kind: 'pnpm-lock',
        lockfileSha256: lockfile.sha256,
        packageJsonSha256,
        path: lockfile.path,
      },
      tool: { id: DEPENDENCY_SCANNER_ID, version: toolVersion },
    });
  }

  const target = {
    kind: 'pnpm-lock' as const,
    lockfileSha256: lockfile.sha256,
    packageJsonSha256,
    path: lockfile.path,
  };

  try {
    const { policyHits, severityCounts } = parsePnpmAuditJson(parsed);
    const exitCode = processResult.code;

    // Exit matrix (fail-closed):
    // - 0 + zero high/critical → passed
    // - 1 + high/critical hits → failed (policy)
    // - 1 + zero hits → unavailable (unexpected advisory exit)
    // - any other nonzero (e.g. 99) even with parseable zero metadata → unavailable
    // - 0 + nonzero hits → failed (trust counts over exit)
    if (exitCode !== 0 && exitCode !== 1) {
      return artifact({
        checkId: 'dependency-scan',
        exitCode,
        failSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
        policyHits,
        reason: 'unexpected-scanner-exit',
        schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
        severityCounts,
        status: 'unavailable',
        target,
        tool: { id: DEPENDENCY_SCANNER_ID, version: toolVersion },
      });
    }

    if (policyHits > 0) {
      return artifact({
        checkId: 'dependency-scan',
        exitCode,
        failSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
        policyHits,
        reason: 'policy-severity-hits',
        schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
        severityCounts,
        status: 'failed',
        target,
        tool: { id: DEPENDENCY_SCANNER_ID, version: toolVersion },
      });
    }

    if (exitCode === 1) {
      return artifact({
        checkId: 'dependency-scan',
        exitCode,
        failSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
        policyHits: 0,
        reason: 'unexpected-advisory-exit',
        schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
        severityCounts,
        status: 'unavailable',
        target,
        tool: { id: DEPENDENCY_SCANNER_ID, version: toolVersion },
      });
    }

    return artifact({
      checkId: 'dependency-scan',
      exitCode: 0,
      failSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
      policyHits: 0,
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      severityCounts,
      status: 'passed',
      target,
      tool: { id: DEPENDENCY_SCANNER_ID, version: toolVersion },
    });
  } catch {
    return artifact({
      checkId: 'dependency-scan',
      exitCode: processResult.code,
      failSeverities: [...DEPENDENCY_FAIL_SEVERITIES],
      policyHits: 0,
      reason: 'malformed-audit-output',
      schemaVersion: SECURITY_ACCEPTANCE_SCHEMA_VERSION,
      status: 'unavailable',
      target,
      tool: { id: DEPENDENCY_SCANNER_ID, version: toolVersion },
    });
  }
};
