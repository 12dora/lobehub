/**
 * Shared workspace permission gate for settings writes (legacy update + patch/reset).
 * Workspace roles never satisfy platform admin permissions — only workspace RBAC here.
 */

import { RbacModel } from '@/database/models/rbac';
import type { LobeChatDatabase } from '@/database/type';

const OWNER_SETTING_TOP_LEVEL = new Set(['defaultAgent', 'image', 'memory', 'systemAgent', 'tts']);
const MEMBER_SETTING_TOP_LEVEL = new Set(['tool']);

const WORKSPACE_UPDATE_PERMISSION = 'workspace:update:all';
const WORKSPACE_CONTENT_PERMISSIONS = ['agent:update:all', 'agent:update:owner'] as const;

export type WorkspaceSettingsPermissionResult = { ok: true } | { ok: false; reason: 'FORBIDDEN' };

const topLevelOf = (path: string): string => path.split('.')[0] ?? path;

/**
 * Resolve whether a set of setting paths/top-level keys requires owner or member rights.
 */
export const classifySettingsPermissionTier = (
  pathsOrTopKeys: string[],
): 'none' | 'member' | 'owner' => {
  let needsOwner = false;
  let needsMember = false;
  for (const raw of pathsOrTopKeys) {
    const top = topLevelOf(raw);
    if (OWNER_SETTING_TOP_LEVEL.has(top)) needsOwner = true;
    if (MEMBER_SETTING_TOP_LEVEL.has(top)) needsMember = true;
  }
  if (needsOwner) return 'owner';
  if (needsMember) return 'member';
  return 'none';
};

/**
 * Assert workspace permission for writing the given paths (or top-level keys).
 * No-op when `workspaceId` is absent (personal context).
 */
export const assertWorkspaceSettingsWritePermission = async (params: {
  db: LobeChatDatabase;
  paths: string[];
  userId: string;
  workspaceId?: string | null;
}): Promise<WorkspaceSettingsPermissionResult> => {
  if (!params.workspaceId) return { ok: true };

  const tier = classifySettingsPermissionTier(params.paths);
  if (tier === 'none') return { ok: true };

  const rbac = new RbacModel(params.db, params.userId);
  if (tier === 'owner') {
    const allowed = await rbac.hasPermission(WORKSPACE_UPDATE_PERMISSION, {
      workspaceId: params.workspaceId,
    });
    return allowed ? { ok: true } : { ok: false, reason: 'FORBIDDEN' };
  }

  const allowed = await rbac.hasAnyPermission([...WORKSPACE_CONTENT_PERMISSIONS], {
    workspaceId: params.workspaceId,
  });
  return allowed ? { ok: true } : { ok: false, reason: 'FORBIDDEN' };
};
