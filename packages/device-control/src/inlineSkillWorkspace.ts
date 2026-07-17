import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';

import {
  type InlineSkillResource,
  validateInlineSkillOperationPayloads,
} from './inlineSkillResources';

const DEFAULT_WORKSPACE_TTL_MS = 15 * 60 * 1000;
const activeWorkspaces = new Map<string, string>();

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
  now?: () => number;
  ttlMs?: number;
}

const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');

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

export const prepareInlineSkillWorkspace = async (
  params: PrepareInlineSkillWorkspaceParams,
  deps: InlineSkillWorkspaceDeps = {},
): Promise<PrepareInlineSkillWorkspaceResult> => {
  let workspaceDir: string | undefined;
  try {
    if (!params.operationId || params.operationId.length > 256) {
      throw new Error('A bounded operationId is required for inline Skill materialization');
    }
    if (!/^[a-f0-9]{64}$/.test(params.checksum)) {
      throw new Error('An exact Skill checksum is required for inline Skill materialization');
    }
    const [{ resources }] = validateInlineSkillOperationPayloads([params]);
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
    activeWorkspaces.set(workspaceId, workspaceDir);
    const timer = setTimeout(() => {
      void cleanupInlineSkillWorkspace({ workspaceId });
    }, deps.ttlMs ?? DEFAULT_WORKSPACE_TTL_MS);
    timer.unref?.();
    return { success: true, workspaceDir, workspaceId };
  } catch (error) {
    if (workspaceDir) await rm(workspaceDir, { force: true, recursive: true });
    return { error: (error as Error).message, success: false };
  }
};

export const cleanupInlineSkillWorkspace = async (params: { workspaceId: string }) => {
  const workspaceDir = activeWorkspaces.get(params.workspaceId);
  if (!workspaceDir) return { success: true };
  activeWorkspaces.delete(params.workspaceId);
  await rm(workspaceDir, { force: true, recursive: true });
  return { success: true };
};
