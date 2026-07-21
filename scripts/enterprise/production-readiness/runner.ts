/**
 * Production preflight runner: load gate evidence + optional provenance, evaluate, write report.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { dispatchAllowlistedCommand } from './commands';
import { type PreflightMode, PRODUCTION_READINESS_LANE } from './constants';
import { deriveExitCode, evaluateProductionReadiness, type GateEvidenceInput } from './evaluate';
import type { FreshnessOptions } from './freshness';
import { type CleanupProof, cleanupToolOwnedPath, writeJsonAtomic } from './fsUtils';
import {
  type ProductionReadinessReport,
  type ReleaseCandidate,
  releaseCandidateSchema,
  type ReleasePlan,
  releasePlanSchema,
} from './schemas';
import { PRODUCTION_TRUST_POLICY, type TrustPolicy } from './trust';

export interface RunPreflightOptions {
  candidate: ReleaseCandidate;
  cleanupTargets?: Array<{ path: string; proof: CleanupProof }>;
  evidence: GateEvidenceInput[];
  freshness?: FreshnessOptions;
  mode: PreflightMode;
  outputPath: string;
  plan: ReleasePlan;
  trustPolicy?: TrustPolicy;
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

  for (const target of options.cleanupTargets ?? []) {
    const result = await cleanupToolOwnedPath(target.path, target.proof);
    if (result === 'failed') cleanupResult = 'failed';
  }

  // CLI always uses PRODUCTION_TRUST_POLICY unless tests inject via API.
  const policy =
    options.mode === 'production-authorized'
      ? (options.trustPolicy ?? PRODUCTION_TRUST_POLICY)
      : (options.trustPolicy ?? PRODUCTION_TRUST_POLICY);

  const evaluation = evaluateProductionReadiness({
    candidate: options.candidate,
    cleanupResult,
    evidence: options.evidence,
    freshness: options.freshness,
    mode: options.mode,
    plan: options.plan,
    startedAtMs,
    trustPolicy: policy,
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

/**
 * Load gate evidence envelopes. Self-declared production-authorized without
 * provenance is accepted as raw input but evaluate will fail it closed.
 */
export const loadGateEvidenceFile = async (filePath: string): Promise<GateEvidenceInput> => {
  const raw = (await loadJsonFile(filePath)) as GateEvidenceInput;
  if (!raw.gate || !raw.candidateSha || !raw.artifactSha256 || !raw.generatedAt) {
    throw new Error(`Evidence file missing required fields: ${path.basename(filePath)}`);
  }
  return raw;
};

export const loadEvidenceDirectory = async (
  directory: string,
  fileNames: string[],
): Promise<GateEvidenceInput[]> => {
  const evidence: GateEvidenceInput[] = [];
  for (const name of fileNames) {
    evidence.push(await loadGateEvidenceFile(path.join(directory, name)));
  }
  return evidence;
};

export const runDispatchCommand = async (options: {
  commandId: string;
  confirmExecute: boolean;
  execute: boolean;
  stateDir?: string;
  windowId?: string;
}) => dispatchAllowlistedCommand(options);

export { deriveExitCode };
