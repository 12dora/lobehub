/**
 * Production preflight runner: load inputs, evaluate, write atomic report.
 * Read-only by default. Optional allowlisted command dispatch with confirmation.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { dispatchAllowlistedCommand } from './commands';
import { type PreflightMode, PRODUCTION_READINESS_LANE } from './constants';
import { deriveExitCode, evaluateProductionReadiness } from './evaluate';
import type { FreshnessOptions } from './freshness';
import { cleanupToolOwnedPath, writeJsonAtomic } from './fsUtils';
import {
  type EvidenceEnvelope,
  evidenceEnvelopeSchema,
  type ProductionReadinessReport,
  type ReleaseCandidate,
  releaseCandidateSchema,
  type ReleasePlan,
  releasePlanSchema,
} from './schemas';

export interface RunPreflightOptions {
  candidate: ReleaseCandidate;
  cleanupPaths?: string[];
  evidence: EvidenceEnvelope[];
  freshness?: FreshnessOptions;
  mode: PreflightMode;
  outputPath: string;
  plan: ReleasePlan;
}

export interface RunPreflightResult {
  exitCode: number;
  report: ProductionReadinessReport;
  reportSha256: string;
}

export const runProductionPreflight = async (
  options: RunPreflightOptions,
): Promise<RunPreflightResult> => {
  const startedAtMs = Date.now();
  let cleanupResult: 'failed' | 'passed' = 'passed';

  try {
    // Re-seal with cleanup after tool-owned temp cleanup.
    for (const cleanupPath of options.cleanupPaths ?? []) {
      const result = await cleanupToolOwnedPath(cleanupPath);
      if (result === 'failed') cleanupResult = 'failed';
    }

    const evaluation = evaluateProductionReadiness({
      candidate: options.candidate,
      cleanupResult,
      evidence: options.evidence,
      freshness: options.freshness,
      mode: options.mode,
      plan: options.plan,
      startedAtMs,
    });

    const { sha256 } = await writeJsonAtomic(options.outputPath, evaluation.report);
    await writeJsonAtomic(`${options.outputPath}.sha256.json`, {
      lane: PRODUCTION_READINESS_LANE,
      sha256,
    });

    return {
      exitCode: evaluation.exitCode,
      report: evaluation.report,
      reportSha256: sha256,
    };
  } catch (error) {
    // Fail closed: no partial success artifact pretending to pass.
    const message = error instanceof Error ? error.message : 'preflight-failed';
    throw new Error(message, { cause: error });
  }
};

export const loadJsonFile = async (filePath: string): Promise<unknown> => {
  const raw = await readFile(path.resolve(filePath), 'utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Malformed JSON: ${path.basename(filePath)}`);
  }
};

export const loadReleaseCandidateFile = async (filePath: string): Promise<ReleaseCandidate> =>
  releaseCandidateSchema.parse(await loadJsonFile(filePath));

export const loadReleasePlanFile = async (filePath: string): Promise<ReleasePlan> =>
  releasePlanSchema.parse(await loadJsonFile(filePath));

export const loadEvidenceFile = async (filePath: string): Promise<EvidenceEnvelope> =>
  evidenceEnvelopeSchema.parse(await loadJsonFile(filePath));

export const loadEvidenceDirectory = async (
  directory: string,
  fileNames: string[],
): Promise<EvidenceEnvelope[]> => {
  const evidence: EvidenceEnvelope[] = [];
  for (const name of fileNames) {
    const filePath = path.join(directory, name);
    evidence.push(await loadEvidenceFile(filePath));
  }
  return evidence;
};

export const runDispatchCommand = async (options: {
  commandId: string;
  confirmExecute: boolean;
  execute: boolean;
  cwd?: string;
}) => dispatchAllowlistedCommand(options);

export { deriveExitCode };
