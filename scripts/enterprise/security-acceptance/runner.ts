/**
 * Security acceptance runner: execute checks, evaluate, write artifacts + report.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { serializePretty } from './canonical';
import { runDependencyScan } from './dependencyScan';
import { evaluateSecurityAcceptance, verifySecurityAcceptanceReport } from './evaluate';
import { runLeakageScan } from './leakageScan';
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
  /** Fixed ISO timestamp for deterministic tests. */
  nowIso?: string;
  outputDir: string;
  /** Inject pen manifest (tests). */
  penManifest?: readonly PenAdapterDefinition[];
  /** Inject process runner (tests). */
  runProcess?: ProcessRunner;
  /** Skip real dependency network scan (tests must still inject artifacts via evaluate). */
  skipDependencyScan?: boolean;
  skipLeakageScan?: boolean;
  skipPenRegression?: boolean;
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

/**
 * Full security acceptance run. Fail-closed: unavailable checks never become passes.
 */
export const runSecurityAcceptance = async (
  options: RunSecurityAcceptanceOptions,
): Promise<RunSecurityAcceptanceResult> => {
  const checksDir = path.join(options.outputDir, 'checks');
  await mkdir(checksDir, { recursive: true });

  let dependency: DependencyScanArtifact;
  if (options.skipDependencyScan) {
    throw new Error('skipDependencyScan is not a pass path; use evaluate with explicit artifacts');
  } else {
    dependency = await runDependencyScan({
      allowGenerateLockfile: options.allowGenerateLockfile,
      cwd: options.cwd,
      runProcess: options.runProcess,
    });
  }
  await writeJson(path.join(checksDir, 'dependency-scan.json'), dependency);

  let leakage: LeakageScanArtifact;
  if (options.skipLeakageScan) {
    throw new Error('skipLeakageScan is not a pass path; use evaluate with explicit artifacts');
  } else {
    leakage = await runLeakageScan({ cwd: options.cwd });
  }
  await writeJson(path.join(checksDir, 'leakage-scan.json'), leakage);

  let pen: PenRegressionArtifact;
  if (options.skipPenRegression) {
    throw new Error('skipPenRegression is not a pass path; use evaluate with explicit artifacts');
  } else {
    pen = await runPenRegression({
      cwd: options.cwd,
      manifest: options.penManifest,
      runProcess: options.runProcess,
    });
  }
  await writeJson(path.join(checksDir, 'pen-regression.json'), pen);

  const { exitCode, report } = evaluateSecurityAcceptance({
    dependency,
    gitSha: options.gitSha,
    leakage,
    nowIso: options.nowIso,
    pen,
  });

  const reportPath = path.join(options.outputDir, 'security-acceptance.report.json');
  const reportSha256 = await writeJson(reportPath, report);
  await writeJson(path.join(options.outputDir, 'security-acceptance.report.sha256.json'), {
    lane: report.lane,
    schemaVersion: report.schemaVersion,
    sha256: reportSha256,
  });

  // Classification sidecar: never claims production pen-test.
  await writeJson(path.join(options.outputDir, 'classification.json'), {
    evidenceClass: report.evidenceClass,
    externalPenetrationTest: report.externalPenetrationTest,
    lane: report.lane,
    overall: report.overall,
    productionPassed: false,
  });

  return { exitCode, report, reportPath, reportSha256 };
};

/**
 * Evaluate pre-collected check artifacts from a directory.
 */
export const evaluateFromChecksDir = async (options: {
  checksDir: string;
  gitSha: string;
  nowIso?: string;
  outputDir: string;
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
