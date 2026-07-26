import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';

import {
  type InlineSkillResource,
  type ValidatedInlineSkillResource,
  validateInlineSkillOperationPayloads,
} from './inlineSkillResources';

const DEFAULT_WORKSPACE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CLEANUP_RETRY_BASE_MS = 1000;
const DEFAULT_CLEANUP_RETRY_COUNT = 3;

interface ActiveWorkspaceEntry {
  timer: ReturnType<typeof setTimeout>;
  workspaceDir: string;
}

const activeWorkspaces = new Map<string, ActiveWorkspaceEntry>();

export interface PrepareInlineSkillWorkspaceParams {
  checksum: string;
  operationId: string;
  resources: InlineSkillResource[];
  skillContent: string;
  skillKey: string;
  version: string;
}

export interface PrepareInlineSkillWorkspaceResult {
  error?: string;
  success: boolean;
  workspaceDir?: string;
  workspaceId?: string;
}

export interface InlineSkillWorkspaceDeps {
  cacheRoot?: string;
  /** Injectable for tests — defaults to clearTimeout. */
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Base delay for bounded exponential cleanup retries. */
  cleanupRetryBaseMs?: number;
  /** Number of cleanup retries after the initial TTL attempt. */
  cleanupRetryCount?: number;
  now?: () => number;
  /** Injectable for tests — defaults to recursive force-rm. */
  removePath?: (target: string) => Promise<void>;
  /** Injectable for tests — defaults to setTimeout. */
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  ttlMs?: number;
}

const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');

/** SHA-256 of UTF-8 content — Node-only integrity check at the materialization boundary. */
export const hashInlineSkillContent = (content: string) =>
  createHash('sha256').update(content, 'utf8').digest('hex');

/**
 * Verify every resource's declared checksum matches its content bytes before any file is written.
 * Kept out of the browser-safe validation module so that path never imports Node crypto.
 */
export const assertInlineSkillResourceChecksums = (resources: ValidatedInlineSkillResource[]) => {
  for (const resource of resources) {
    const digest = hashInlineSkillContent(resource.content);
    if (digest !== resource.checksum) {
      throw new Error(`Inline Skill resource integrity check failed: ${resource.path}`);
    }
  }
};

const assertOwnedDirectory = async (target: string) => {
  const metadata = await lstat(target);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Inline Skill workspace directory is unsafe');
  }
  if (currentUid !== undefined && metadata.uid !== currentUid) {
    throw new Error('Inline Skill workspace directory owner is unsafe');
  }
};

export const defaultInlineSkillWorkspaceRoot = () =>
  path.join(os.tmpdir(), 'lobehub-managed-skills');

const sweepExpiredWorkspaces = async (root: string, now: number, ttlMs: number) => {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.slice(0, 256).map(async (entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return;
      const target = path.join(root, entry.name);
      const metadata = await stat(target).catch(() => undefined);
      if (metadata && now - metadata.mtimeMs > ttlMs) {
        await rm(target, { force: true, recursive: true });
      }
    }),
  );
};

const defaultRemovePath = (target: string) => rm(target, { force: true, recursive: true });

const scheduleWorkspaceCleanup = (
  workspaceId: string,
  delayMs: number,
  attempt: number,
  deps: Required<Pick<InlineSkillWorkspaceDeps, 'cancelSchedule' | 'removePath' | 'schedule'>> & {
    cleanupRetryBaseMs: number;
    cleanupRetryCount: number;
  },
) => {
  const timer = deps.schedule(() => {
    void cleanupInlineSkillWorkspace(
      { workspaceId },
      { cancelSchedule: deps.cancelSchedule, removePath: deps.removePath },
    ).catch((error: unknown) => {
      const entry = activeWorkspaces.get(workspaceId);
      if (!entry) return;

      if (attempt >= deps.cleanupRetryCount) {
        console.error('[InlineSkillWorkspace] TTL cleanup retries exhausted', {
          attempt,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        return;
      }

      const retryDelay = deps.cleanupRetryBaseMs * 2 ** attempt;
      entry.timer = scheduleWorkspaceCleanup(workspaceId, retryDelay, attempt + 1, deps);
    });
  }, delayMs);
  timer.unref?.();
  return timer;
};

export const prepareInlineSkillWorkspace = async (
  params: PrepareInlineSkillWorkspaceParams,
  deps: InlineSkillWorkspaceDeps = {},
): Promise<PrepareInlineSkillWorkspaceResult> => {
  let workspaceDir: string | undefined;
  const removePath = deps.removePath ?? defaultRemovePath;
  const schedule = deps.schedule ?? setTimeout;
  const cancelSchedule = deps.cancelSchedule ?? clearTimeout;
  try {
    if (!params.operationId || params.operationId.length > 256) {
      throw new Error('A bounded operationId is required for inline Skill materialization');
    }
    if (!/^[a-f0-9]{64}$/.test(params.checksum)) {
      throw new Error('An exact Skill checksum is required for inline Skill materialization');
    }
    const [{ resources }] = validateInlineSkillOperationPayloads([params]);
    // Real digest comparison happens only here (Node boundary), not in the browser-safe validator.
    assertInlineSkillResourceChecksums(resources);

    const root = path.resolve(deps.cacheRoot ?? defaultInlineSkillWorkspaceRoot());
    await mkdir(root, { mode: 0o700, recursive: true });
    await assertOwnedDirectory(root);
    await chmod(root, 0o700);
    await sweepExpiredWorkspaces(
      root,
      (deps.now ?? Date.now)(),
      deps.ttlMs ?? DEFAULT_WORKSPACE_TTL_MS,
    );

    // Raw skillKey/version never enter filesystem paths. The prefix carries only the operation and
    // exact version checksum, while mkdtemp provides isolation for concurrent tool calls.
    const prefix = `${hashToken(params.operationId).slice(0, 24)}-${params.checksum}-`;
    workspaceDir = await mkdtemp(path.join(root, prefix));
    await assertOwnedDirectory(workspaceDir);
    await chmod(workspaceDir, 0o700);
    await writeFile(path.join(workspaceDir, 'SKILL.md'), params.skillContent, {
      flag: 'wx',
      mode: 0o600,
    });

    for (const resource of resources) {
      const target = path.join(workspaceDir, ...resource.path.split('/'));
      await mkdir(path.dirname(target), { mode: 0o700, recursive: true });
      await assertOwnedDirectory(path.dirname(target));
      await chmod(path.dirname(target), 0o700);
      await writeFile(target, resource.content, { flag: 'wx', mode: 0o600 });
    }

    const workspaceId = randomUUID();
    const timer = scheduleWorkspaceCleanup(workspaceId, deps.ttlMs ?? DEFAULT_WORKSPACE_TTL_MS, 0, {
      cancelSchedule,
      cleanupRetryBaseMs: deps.cleanupRetryBaseMs ?? DEFAULT_CLEANUP_RETRY_BASE_MS,
      cleanupRetryCount: deps.cleanupRetryCount ?? DEFAULT_CLEANUP_RETRY_COUNT,
      removePath,
      schedule,
    });
    activeWorkspaces.set(workspaceId, { timer, workspaceDir });
    return { success: true, workspaceDir, workspaceId };
  } catch (error) {
    if (workspaceDir) await removePath(workspaceDir).catch(() => undefined);
    return { error: (error as Error).message, success: false };
  }
};

export const cleanupInlineSkillWorkspace = async (
  params: { workspaceId: string },
  deps: Pick<InlineSkillWorkspaceDeps, 'removePath' | 'cancelSchedule'> = {},
) => {
  const entry = activeWorkspaces.get(params.workspaceId);
  if (!entry) return { success: true };

  const removePath = deps.removePath ?? defaultRemovePath;
  const cancelSchedule = deps.cancelSchedule ?? clearTimeout;

  // Delete files first. Only drop map state + cancel the TTL timer after rm succeeds so a failed
  // deletion remains retryable (gateway bounded retry, manual re-invoke, or later TTL).
  await removePath(entry.workspaceDir);
  activeWorkspaces.delete(params.workspaceId);
  cancelSchedule(entry.timer);
  return { success: true };
};

/** Test-only: clear in-memory workspace registry between cases. */
export const __resetInlineSkillWorkspacesForTests = () => {
  for (const entry of activeWorkspaces.values()) {
    clearTimeout(entry.timer);
  }
  activeWorkspaces.clear();
};
