/**
 * Security acceptance runner: execute checks, evaluate, write artifacts + report.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { serializePretty } from './canonical';
import { runDependencyScan } from './dependencyScan';
import { evaluateSecurityAcceptance, verifySecurityAcceptanceReport } from './evaluate';
import { buildBaselineDocument, LEAKAGE_BASELINE_RELATIVE_PATH } from './leakageBaseline';
import { collectLeakageFingerprints, runLeakageScan } from './leakageScan';
import type { PenAdapterDefinition } from './penManifest';
import { runPenRegression } from './penRegression';
import { sha256Hex } from './privacy';
import type { ProcessRunner } from './process';
import type {
  DependencyScanArtifact,
  LeakageScanArtifact,
  PenRegressionArtifact,
  SecurityAcceptanceReport,
} from './schemas';

export interface RunSecurityAcceptanceOptions {
  allowGenerateLockfile?: boolean;
  cwd: string;
  gitSha: string;
  nowIso?: string;
  outputDir: string;
  penManifest?: readonly PenAdapterDefinition[];
  runProcess?: ProcessRunner;
}

export interface RunSecurityAcceptanceResult {
  exitCode: number;
  report: SecurityAcceptanceReport;
  reportPath: string;
  reportSha256: string;
}

const writeJson = async (filePath: string, value: unknown): Promise<string> => {
  const serialized = serializePretty(value);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serialized, 'utf8');
  return sha256Hex(serialized);
};

export const runSecurityAcceptance = async (
  options: RunSecurityAcceptanceOptions,
): Promise<RunSecurityAcceptanceResult> => {
  const checksDir = path.join(options.outputDir, 'checks');
  await mkdir(checksDir, { recursive: true });

  const dependency = await runDependencyScan({
    allowGenerateLockfile: options.allowGenerateLockfile,
    cwd: options.cwd,
    runProcess: options.runProcess,
  });
  await writeJson(path.join(checksDir, 'dependency-scan.json'), dependency);

  const leakage = await runLeakageScan({ cwd: options.cwd });
  await writeJson(path.join(checksDir, 'leakage-scan.json'), leakage);

  const pen = await runPenRegression({
    cwd: options.cwd,
    manifest: options.penManifest,
    runProcess: options.runProcess,
  });
  await writeJson(path.join(checksDir, 'pen-regression.json'), pen);

  const { exitCode, report } = evaluateSecurityAcceptance({
    dependency,
    gitSha: options.gitSha,
    leakage,
    nowIso: options.nowIso,
    pen,
    penManifest: options.penManifest,
  });

  const reportPath = path.join(options.outputDir, 'security-acceptance.report.json');
  const reportSha256 = await writeJson(reportPath, report);
  await writeJson(path.join(options.outputDir, 'security-acceptance.report.sha256.json'), {
    lane: report.lane,
    schemaVersion: report.schemaVersion,
    sha256: reportSha256,
  });

  await writeJson(path.join(options.outputDir, 'classification.json'), {
    evidenceClass: report.evidenceClass,
    externalPenetrationTest: report.externalPenetrationTest,
    lane: report.lane,
    overall: report.overall,
    productionPassed: false,
  });

  return { exitCode, report, reportPath, reportSha256 };
};

export const evaluateFromChecksDir = async (options: {
  checksDir: string;
  gitSha: string;
  nowIso?: string;
  outputDir: string;
  penManifest?: readonly PenAdapterDefinition[];
}): Promise<RunSecurityAcceptanceResult> => {
  const load = async (name: string): Promise<unknown> => {
    const raw = await readFile(path.join(options.checksDir, name), 'utf8');
    return JSON.parse(raw) as unknown;
  };

  const dependency = (await load('dependency-scan.json')) as DependencyScanArtifact;
  const leakage = (await load('leakage-scan.json')) as LeakageScanArtifact;
  const pen = (await load('pen-regression.json')) as PenRegressionArtifact;

  const { exitCode, report } = evaluateSecurityAcceptance({
    dependency,
    gitSha: options.gitSha,
    leakage,
    nowIso: options.nowIso,
    pen,
    penManifest: options.penManifest,
  });

  await mkdir(options.outputDir, { recursive: true });
  const reportPath = path.join(options.outputDir, 'security-acceptance.report.json');
  const reportSha256 = await writeJson(reportPath, report);
  await writeJson(path.join(options.outputDir, 'security-acceptance.report.sha256.json'), {
    lane: report.lane,
    schemaVersion: report.schemaVersion,
    sha256: reportSha256,
  });

  return { exitCode, report, reportPath, reportSha256 };
};

export const verifyReportFile = async (
  reportPath: string,
): Promise<{ ok: true; report: SecurityAcceptanceReport } | { ok: false; reason: string }> => {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(reportPath, 'utf8')) as unknown;
  } catch {
    return { ok: false, reason: 'malformed-report-json' };
  }
  return verifySecurityAcceptanceReport(value);
};

/**
 * Generate reviewed leakage baseline from current repo fingerprints.
 * Excludes exact fixture allowlist entries (they stay on the allowlist).
 * Does not write secret text — only path/category/lineDigest.
 */
export const generateLeakageBaselineFile = async (options: {
  cwd: string;
  outputPath?: string;
}): Promise<{ count: number; path: string }> => {
  const { isExactAllowlistedFinding } = await import('./leakageAllowlist');
  const fingerprints = await collectLeakageFingerprints({ cwd: options.cwd });
  const baselinable = fingerprints.filter((entry) => !isExactAllowlistedFinding(entry));
  const document = buildBaselineDocument(baselinable);
  const outputPath = options.outputPath ?? path.join(options.cwd, LEAKAGE_BASELINE_RELATIVE_PATH);
  await writeJson(outputPath, document);
  return { count: document.entries.length, path: outputPath };
};
