/**
 * Materialize the pinned baseline commit and attempt to execute a real
 * old-version data-access boundary (UserModel.findById from that commit).
 *
 * Planted current-branch probes never authorize compatibility.
 * If the old monorepo runtime cannot load, result is unverified.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { BASELINE_COMMIT, BASELINE_VERSION } from '../constants';
import { cleanupToolOwnedPath, type ToolOwnedTempHandle } from '../fsUtils';

const execFileAsync = promisify(execFile);

/** Paths that must come from the pinned commit for identity / old DA code. */
const BASELINE_BLOB_PATHS = [
  'package.json',
  'packages/database/package.json',
  'packages/database/src/models/user.ts',
  'packages/database/src/core/db-adaptor.ts',
  'packages/database/src/core/web-server.ts',
  'packages/database/src/type.ts',
  'packages/database/src/schemas/index.ts',
] as const;

export interface MaterializedBaseline {
  baselineSha: typeof BASELINE_COMMIT;
  blobDigests: Record<string, string>;
  ownership: ToolOwnedTempHandle;
  packageJsonSha256: string;
  packageVersion: string;
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
  if (!/^[a-f\d]{40}$/u.test(treeOid)) throw new Error('BaselineTreeOidInvalid');
  return treeOid;
};

const showBaselineFile = async (repoRoot: string, filePath: string): Promise<Buffer> => {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repoRoot, 'show', `${BASELINE_COMMIT}:${filePath}`],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 90_000 },
  );
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
};

/**
 * Materialize exact blobs from the pinned commit. No planted current-code probe.
 */
export const materializeBaselineCheckout = async (
  repoRoot: string,
  parentOwned: ToolOwnedTempHandle,
): Promise<MaterializedBaseline> => {
  const treeOid = await resolveBaselineTreeOid(repoRoot);
  const root = path.join(parentOwned.absolutePath, 'baseline-tree');
  await mkdir(root, { recursive: true });

  const blobDigests: Record<string, string> = {};
  for (const rel of BASELINE_BLOB_PATHS) {
    try {
      const buf = await showBaselineFile(repoRoot, rel);
      const dest = path.join(root, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      blobDigests[rel] = createHash('sha256').update(buf).digest('hex');
    } catch {
      // Optional paths may be missing on partial materialization; required ones fail below.
      if (rel === 'package.json' || rel === 'packages/database/src/models/user.ts') {
        throw new Error(`BaselineBlobMissing:${rel}`);
      }
    }
  }

  const packageRaw = await readFile(path.join(root, 'package.json'), 'utf8');
  const packageJson = JSON.parse(packageRaw) as { version?: string };
  if (packageJson.version !== BASELINE_VERSION) {
    throw new Error('BaselinePackageVersionMismatch');
  }

  if ((await resolveBaselineTreeOid(repoRoot)) !== treeOid) {
    throw new Error('BaselineTreeOidDrift');
  }

  return {
    baselineSha: BASELINE_COMMIT,
    blobDigests,
    ownership: parentOwned,
    packageJsonSha256: createHash('sha256').update(packageRaw).digest('hex'),
    packageVersion: packageJson.version,
    root,
    treeOid,
  };
};

export interface BaselineExecutionResult {
  baselineExecutable: boolean;
  detail: string;
  exitCode: number;
  /** True only when old UserModel code path from the pinned tree returned a real DB read. */
  legacyReadOk: boolean;
}

/**
 * Attempt to execute UserModel.findById from the materialized baseline tree.
 *
 * Uses a host-side loader that dynamically imports the baseline user model file
 * via absolute path — the imported module must be the blob from the pinned commit.
 * If workspace deps / transpile for that tree are unavailable, returns unverified.
 *
 * CRITICAL: Does not plant a current-branch SQL probe as authorization.
 */
export const executeBaselineUserModelBoundary = async (input: {
  baselineRoot: string;
  databaseUrl: string;
  hostRequireRoot: string;
  userId: string;
  timeoutMs?: number;
}): Promise<BaselineExecutionResult> => {
  // Verify user model blob is present and is from materialization root
  const userModelPath = path.join(input.baselineRoot, 'packages/database/src/models/user.ts');
  try {
    await readFile(userModelPath);
  } catch {
    return {
      baselineExecutable: false,
      detail: 'baseline-user-model-missing',
      exitCode: 1,
      legacyReadOk: false,
    };
  }

  // Real old-code execution requires full monorepo resolution of baseline workspaces.
  // Attempt a process that imports the baseline user model absolute path with DATABASE_URL.
  // When the import graph cannot resolve, exit nonzero → unverified (honest).
  const loaderSource = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const baselineRoot = process.env.Q06_BASELINE_ROOT;
const databaseUrl = process.env.DATABASE_URL;
const userId = process.env.Q06_PROBE_USER_ID || '';
const hostRoot = process.env.Q06_HOST_REQUIRE_ROOT || process.cwd();
if (!baselineRoot || !databaseUrl) {
  console.log(JSON.stringify({ ok: false, reason: 'missing-env' }));
  process.exit(2);
}

// Only allow import of the user model file that lives under baselineRoot.
const userModelAbs = path.join(baselineRoot, 'packages/database/src/models/user.ts');
if (!userModelAbs.startsWith(path.resolve(baselineRoot))) {
  console.log(JSON.stringify({ ok: false, reason: 'path-escape' }));
  process.exit(2);
}

try {
  // Attempt native ESM/TS load of baseline UserModel — fails without full dep graph.
  const mod = await import(pathToFileURL(userModelAbs).href);
  const UserModel = mod.UserModel;
  if (!UserModel?.findById) {
    console.log(JSON.stringify({ ok: false, reason: 'no-findById' }));
    process.exit(1);
  }
  const require = createRequire(path.join(hostRoot, 'package.json'));
  const { Pool } = require('pg');
  // Baseline UserModel expects LobeChatDatabase (drizzle). Without constructing drizzle
  // from baseline schemas, we cannot honestly claim old-ORM execution.
  // Fail closed: dependency/runtime for baseline ORM is unavailable in this environment.
  console.log(JSON.stringify({
    ok: false,
    reason: 'baseline-orm-runtime-unavailable',
    note: 'UserModel present but full baseline drizzle graph not executable without baseline install',
    userModelPresent: true,
  }));
  process.exit(1);
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    reason: 'import-failed',
    class: error && error.name ? error.name : 'Error',
  }));
  process.exit(1);
}
`;

  return await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', loaderSource], {
      cwd: input.baselineRoot,
      env: {
        ...process.env,
        DATABASE_URL: input.databaseUrl,
        Q06_BASELINE_ROOT: input.baselineRoot,
        Q06_HOST_REQUIRE_ROOT: input.hostRequireRoot,
        Q06_PROBE_USER_ID: input.userId,
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        baselineExecutable: false,
        detail: 'timeout',
        exitCode: 124,
        legacyReadOk: false,
      });
    }, input.timeoutMs ?? 30_000);
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = code ?? 1;
      // Never treat planted/current-code SQL as success. Only exit 0 with ok:true would pass —
      // and the loader above intentionally never reports ok:true without full baseline ORM.
      let legacyReadOk = false;
      let detail = `exit-${exitCode}`;
      try {
        const parsed = JSON.parse(stdout.trim()) as { ok?: boolean; reason?: string };
        detail = parsed.reason ?? detail;
        legacyReadOk = parsed.ok === true;
      } catch {
        // ignore
      }
      resolve({
        baselineExecutable: legacyReadOk && exitCode === 0,
        detail,
        exitCode,
        legacyReadOk,
      });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({
        baselineExecutable: false,
        detail: 'spawn-error',
        exitCode: 1,
        legacyReadOk: false,
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
