/**
 * Cross-process CAS command state with exclusive lock + replay ledger.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  constants,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

const stateSchema = z
  .object({
    flags: z.record(z.string(), z.boolean()),
    metrics: z.record(z.string(), z.number()),
    opSeq: z.number().int().nonnegative(),
    replay: z
      .record(
        z.string(),
        z
          .object({
            afterDigest: z.string(),
            mode: z.string(),
            opSeq: z.number().int().nonnegative(),
            postcondition: z.string().optional(),
          })
          .strict(),
      )
      .default({}),
    schemaVersion: z.literal(1),
    windowActive: z.string().nullable(),
  })
  .strict();

export type ReadinessCommandState = z.infer<typeof stateSchema>;

export const defaultCommandState = (): ReadinessCommandState => ({
  flags: {
    'branding-cutover': false,
    'connector-shared-credentials': false,
    'default-inbox': false,
    'oidc': false,
  },
  metrics: {
    'auth-failure-rate': 0,
    'error-rate': 0,
    'job-failure-rate': 0,
    'p95-latency-ms': 0,
  },
  opSeq: 0,
  replay: {},
  schemaVersion: 1,
  windowActive: null,
});

export const resolveStatePath = (baseDir: string): string =>
  path.join(baseDir, 'readiness-command-state.json');

export const digestCommandState = (state: ReadinessCommandState): string => {
  // Exclude replay from transition digests for equality of business state? Include all for CAS.
  const { replay: _r, ...business } = state;
  void _r;
  return createHash('sha256').update(JSON.stringify(business)).digest('hex');
};

export const loadCommandState = async (baseDir: string): Promise<ReadinessCommandState> => {
  const filePath = resolveStatePath(baseDir);
  try {
    const st = await lstat(filePath);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('state-not-regular-file');
    const raw = await readFile(filePath, 'utf8');
    return stateSchema.parse(JSON.parse(raw));
  } catch {
    return defaultCommandState();
  }
};

const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 25;

/**
 * Acquire exclusive lock via O_EXCL lock file; bounded wait.
 */
const withStateLock = async <T>(baseDir: string, fn: () => Promise<T>): Promise<T> => {
  await mkdir(baseDir, { recursive: true });
  const lockPath = path.join(baseDir, 'readiness-command-state.lock');
  const token = randomBytes(16).toString('hex');
  const started = Date.now();

  while (true) {
    try {
      const handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(token, 'utf8');
      } finally {
        await handle.close();
      }
      break;
    } catch {
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error('CommandStateLockTimeout');
      }
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      const current = await readFile(lockPath, 'utf8');
      if (current === token) await rm(lockPath, { force: true });
    } catch {
      // leave lock if not ours
    }
  }
};

export const saveCommandState = async (
  baseDir: string,
  state: ReadinessCommandState,
): Promise<void> => {
  await mkdir(baseDir, { recursive: true });
  const parsed = stateSchema.parse(state);
  const filePath = resolveStatePath(baseDir);
  const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, filePath);
};

export interface TransitionResult {
  after: ReadinessCommandState;
  afterDigest: string;
  before: ReadinessCommandState;
  beforeDigest: string;
  mode: 'already-satisfied' | 'conflict' | 'executed' | 'replayed';
  postcondition?: string;
  recorded?: boolean;
}

/**
 * Apply a state transition under exclusive lock with optional operation-id replay.
 */
export const applyCommandTransition = async (input: {
  baseDir: string;
  operationId?: string;
  mutate: (state: ReadinessCommandState) => {
    changed: boolean;
    postcondition: string;
    next: ReadinessCommandState;
  };
}): Promise<TransitionResult> => {
  return withStateLock(input.baseDir, async () => {
    const before = await loadCommandState(input.baseDir);
    const beforeDigest = digestCommandState(before);

    if (input.operationId && before.replay[input.operationId]) {
      const rec = before.replay[input.operationId]!;
      return {
        after: before,
        afterDigest: rec.afterDigest,
        before,
        beforeDigest,
        mode: 'replayed',
        postcondition: rec.postcondition,
        recorded: true,
      };
    }

    const { changed, next, postcondition } = input.mutate(structuredClone(before));
    if (!changed) {
      return {
        after: before,
        afterDigest: beforeDigest,
        before,
        beforeDigest,
        mode: 'already-satisfied',
        postcondition,
      };
    }

    next.opSeq = before.opSeq + 1;
    const afterDigest = digestCommandState(next);
    if (input.operationId) {
      // Bound ledger size
      const entries = Object.entries(next.replay);
      if (entries.length > 64) {
        const trimmed = Object.fromEntries(entries.slice(-48));
        next.replay = trimmed;
      }
      next.replay[input.operationId] = {
        afterDigest,
        mode: 'executed',
        opSeq: next.opSeq,
        postcondition,
      };
    }
    await saveCommandState(input.baseDir, next);
    const reloaded = await loadCommandState(input.baseDir);
    if (digestCommandState(reloaded) !== afterDigest) {
      return {
        after: reloaded,
        afterDigest: digestCommandState(reloaded),
        before,
        beforeDigest,
        mode: 'conflict',
        postcondition: 'cas-mismatch',
      };
    }
    return {
      after: reloaded,
      afterDigest,
      before,
      beforeDigest,
      mode: 'executed',
      postcondition,
      recorded: Boolean(input.operationId),
    };
  });
};

export const HIGH_RISK_FLAG_BY_COMMAND: Record<string, string> = {
  'flag-disable-branding-cutover': 'branding-cutover',
  'flag-disable-connector-shared-credentials': 'connector-shared-credentials',
  'flag-disable-default-inbox': 'default-inbox',
  'flag-disable-oidc': 'oidc',
  'flag-enable-branding-cutover': 'branding-cutover',
  'flag-enable-connector-shared-credentials': 'connector-shared-credentials',
  'flag-enable-default-inbox': 'default-inbox',
  'flag-enable-oidc': 'oidc',
};

/**
 * Resolve and validate that stateDir is a real directory (not a symlink swap target).
 * Used by multiproc tests and optional callers.
 */
export const assertOwnedStateDir = async (baseDir: string): Promise<string> => {
  const abs = path.resolve(baseDir);
  const st = await lstat(abs);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error('state-dir-not-regular-directory');
  }
  return realpath(abs);
};
