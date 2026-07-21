/**
 * Materialize required paths from the pinned baseline commit (partial-clone safe)
 * and execute the allowlisted DB probe with DATABASE_URL.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { BASELINE_COMMIT, BASELINE_VERSION } from '../constants';
import { cleanupToolOwnedPath, type ToolOwnedTempHandle } from '../fsUtils';
import {
  ALLOWLISTED_BASELINE_PROBE_RELATIVE_PATH,
  ALLOWLISTED_BASELINE_PROBE_SHA256,
  ALLOWLISTED_BASELINE_PROBE_SOURCE,
} from './baselineProbeContent';

const execFileAsync = promisify(execFile);

/** Paths required from the pinned tree for identity + schema parsing. */
const REQUIRED_BASELINE_PATHS = ['package.json', 'packages/database/src/schemas'] as const;

export interface MaterializedBaseline {
  baselineSha: typeof BASELINE_COMMIT;
  ownership: ToolOwnedTempHandle;
  packageJsonSha256: string;
  packageVersion: string;
  probeRelativePath: string;
  probeSha256: string;
  root: string;
  treeOid: string;
}

export const resolveBaselineTreeOid = async (repoRoot: string): Promise<string> => {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repoRoot, 'rev-parse', `${BASELINE_COMMIT}^{tree}`],
    { timeout: 30_000 },
  );
  const treeOid = stdout.trim().toLowerCase();
  if (!/^[a-f\d]{40}$/u.test(treeOid)) {
    throw new Error('BaselineTreeOidInvalid');
  }
  return treeOid;
};

const listBaselineFiles = async (repoRoot: string, prefix: string): Promise<string[]> => {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repoRoot, 'ls-tree', '-r', '--name-only', BASELINE_COMMIT, '--', prefix],
    { maxBuffer: 8 * 1024 * 1024, timeout: 60_000 },
  );
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
};

const showBaselineFile = async (repoRoot: string, filePath: string): Promise<Buffer> => {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoRoot, 'show', `${BASELINE_COMMIT}:${filePath}`],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
    );
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch {
    // Partial clone: try to fetch the blob then re-show
    try {
      await execFileAsync(
        'git',
        ['-C', repoRoot, 'cat-file', '-e', `${BASELINE_COMMIT}:${filePath}`],
        { timeout: 30_000 },
      );
    } catch {
      // force object fetch via rev-list
      await execFileAsync(
        'git',
        ['-C', repoRoot, 'fetch', '--filter=blob:none', '--no-tags', 'origin', BASELINE_COMMIT],
        { timeout: 120_000 },
      ).catch(() => undefined);
    }
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoRoot, 'show', `${BASELINE_COMMIT}:${filePath}`],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
    );
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  }
};

/**
 * Materialize only required baseline paths via git show (avoids truncated archive on blob:none).
 */
export const materializeBaselineCheckout = async (
  repoRoot: string,
  parentOwned: ToolOwnedTempHandle,
): Promise<MaterializedBaseline> => {
  const treeOid = await resolveBaselineTreeOid(repoRoot);
  const root = path.join(parentOwned.absolutePath, 'baseline-tree');
  await mkdir(root, { recursive: true });

  // package.json
  const packageRaw = await showBaselineFile(repoRoot, 'package.json');
  await writeFile(path.join(root, 'package.json'), packageRaw);
  const packageJson = JSON.parse(packageRaw.toString('utf8')) as { version?: string };
  if (packageJson.version !== BASELINE_VERSION) {
    throw new Error('BaselinePackageVersionMismatch');
  }

  // Schema tree for identity of data model at baseline
  const schemaFiles = await listBaselineFiles(repoRoot, 'packages/database/src/schemas');
  for (const rel of schemaFiles) {
    if (!rel.endsWith('.ts')) continue;
    const buf = await showBaselineFile(repoRoot, rel);
    const dest = path.join(root, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, buf);
  }

  // Verify tree oid still resolves
  const verifyTree = await resolveBaselineTreeOid(repoRoot);
  if (verifyTree !== treeOid) {
    throw new Error('BaselineTreeOidDrift');
  }

  // Plant allowlisted probe (not in baseline history) after tree verification
  const probePath = path.join(root, ALLOWLISTED_BASELINE_PROBE_RELATIVE_PATH);
  await mkdir(path.dirname(probePath), { recursive: true });
  await writeFile(probePath, ALLOWLISTED_BASELINE_PROBE_SOURCE, 'utf8');
  const probeSha256 = createHash('sha256')
    .update(await readFile(probePath))
    .digest('hex');
  if (probeSha256 !== ALLOWLISTED_BASELINE_PROBE_SHA256) {
    throw new Error('BaselineProbeContentMismatch');
  }

  return {
    baselineSha: BASELINE_COMMIT,
    packageVersion: packageJson.version!,
    packageJsonSha256: createHash('sha256').update(packageRaw).digest('hex'),
    ownership: parentOwned,
    probeRelativePath: ALLOWLISTED_BASELINE_PROBE_RELATIVE_PATH,
    probeSha256,
    root,
    treeOid,
  };
};

export interface BaselineProbeResult {
  detail: string;
  enterpriseRetainedOk: boolean;
  executable: boolean;
  exitCode: number;
  legacyReadOk: boolean;
  packageVersionOk: boolean;
  stdoutDigest: string;
}

export const executeBaselineDbProbe = async (input: {
  baselineRoot: string;
  databaseUrl: string;
  hostRequireRoot: string;
  timeoutMs?: number;
}): Promise<BaselineProbeResult> => {
  const probePath = path.join(input.baselineRoot, ALLOWLISTED_BASELINE_PROBE_RELATIVE_PATH);
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [probePath], {
      cwd: input.baselineRoot,
      env: {
        ...process.env,
        DATABASE_URL: input.databaseUrl,
        Q06_HOST_REQUIRE_ROOT: input.hostRequireRoot,
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        detail: 'timeout',
        enterpriseRetainedOk: false,
        executable: false,
        exitCode: 124,
        legacyReadOk: false,
        packageVersionOk: false,
        stdoutDigest: createHash('sha256').update('').digest('hex'),
      });
    }, input.timeoutMs ?? 60_000);

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      void stderr;
      const exitCode = code ?? 1;
      const stdoutDigest = createHash('sha256').update(stdout).digest('hex');
      if (exitCode !== 0) {
        resolve({
          detail: `exit-${exitCode}:${stderr.slice(0, 120)}`,
          enterpriseRetainedOk: false,
          executable: false,
          exitCode,
          legacyReadOk: false,
          packageVersionOk: false,
          stdoutDigest,
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as {
          enterpriseRetainedOk?: boolean;
          legacyReadOk?: boolean;
          packageVersionOk?: boolean;
        };
        const packageVersionOk = parsed.packageVersionOk === true;
        const legacyReadOk = parsed.legacyReadOk === true;
        const enterpriseRetainedOk = parsed.enterpriseRetainedOk === true;
        resolve({
          detail: 'ok',
          enterpriseRetainedOk,
          executable: packageVersionOk && legacyReadOk && enterpriseRetainedOk,
          exitCode: 0,
          legacyReadOk,
          packageVersionOk,
          stdoutDigest,
        });
      } catch {
        resolve({
          detail: 'bad-output',
          enterpriseRetainedOk: false,
          executable: false,
          exitCode: 1,
          legacyReadOk: false,
          packageVersionOk: false,
          stdoutDigest,
        });
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({
        detail: 'spawn-error',
        enterpriseRetainedOk: false,
        executable: false,
        exitCode: 1,
        legacyReadOk: false,
        packageVersionOk: false,
        stdoutDigest: createHash('sha256').update('').digest('hex'),
      });
    });
  });
};

export const disposeOwnedParent = async (
  ownership: ToolOwnedTempHandle,
): Promise<'failed' | 'passed' | 'skipped'> =>
  cleanupToolOwnedPath(ownership.absolutePath, {
    expectedParentRealpath: ownership.parentRealpath,
    ownerToken: ownership.ownerToken,
    dev: ownership.dev,
    ino: ownership.ino,
  });

void REQUIRED_BASELINE_PATHS;
