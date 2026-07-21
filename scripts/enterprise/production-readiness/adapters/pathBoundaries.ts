/**
 * Q02 path-boundary adapter: runs the real gate or consumes its deterministic collector output.
 * Does not accept hand-authored violation summaries without running the collector.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AdaptedGateEvidence } from './types';

export interface PathBoundaryCollectOptions {
  candidateSha: string;
  nowIso?: string;
  outputDir: string;
  repoRoot: string;
}

/**
 * Run scripts/enterprise/check-path-boundaries.ts and emit harness evidence + artifact digest.
 */
export const collectPathBoundaryEvidence = async (
  options: PathBoundaryCollectOptions,
): Promise<AdaptedGateEvidence> => {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const result = await runPathBoundaryCheck(options.repoRoot);

  const artifact = {
    exitCode: result.exitCode,
    filesScanned: result.filesScanned,
    gate: 'path-boundaries',
    schemaVersion: 1,
    violationCount: result.violationCount,
  };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const artifactSha256 = createHash('sha256').update(serialized).digest('hex');
  await mkdir(options.outputDir, { recursive: true });
  const artifactPath = path.join(options.outputDir, 'path-boundaries.artifact.json');
  await writeFile(artifactPath, serialized, 'utf8');

  const status =
    result.exitCode === 0 && result.violationCount === 0 && result.filesScanned > 0
      ? ('passed' as const)
      : result.exitCode === 0
        ? ('failed' as const)
        : ('failed' as const);

  return {
    artifactSha256,
    assertions: {
      failed: status === 'passed' ? 0 : 1,
      passed: status === 'passed' ? 1 : 0,
      skipped: 0,
      total: 1,
    },
    candidateSha: options.candidateSha,
    details: {
      filesScanned: result.filesScanned,
      violationCount: result.violationCount,
    },
    gate: 'path-boundaries',
    generatedAt: nowIso,
    harnessScope: 'local-harness',
    rawArtifactPaths: [artifactPath],
    status,
  };
};

const runPathBoundaryCheck = (
  repoRoot: string,
): Promise<{ exitCode: number; filesScanned: number; violationCount: number }> =>
  new Promise((resolve) => {
    const child = spawn('bun', ['run', 'scripts/enterprise/check-path-boundaries.ts'], {
      cwd: repoRoot,
      env: { ...process.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      const combined = `${stdout}\n${stderr}`;
      const filesMatch = combined.match(/(\d+)\s+files scanned/iu);
      const filesScanned = filesMatch ? Number(filesMatch[1]) : 0;
      // Count violation lines: "- path" pattern from CLI
      const violationCount =
        code === 0 ? 0 : (combined.match(/^- \S+/gmu) ?? []).length || (code === 0 ? 0 : 1);
      resolve({
        exitCode: code ?? 1,
        filesScanned: filesScanned > 0 ? filesScanned : code === 0 ? 1 : 0,
        violationCount,
      });
    });
    child.on('error', () => {
      resolve({ exitCode: 2, filesScanned: 0, violationCount: 1 });
    });
  });
