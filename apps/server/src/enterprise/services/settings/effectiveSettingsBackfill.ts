import { PlatformSettingsModel } from '@/database/models/platform';
import { UserModel } from '@/database/models/user';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { SettingsMutationLifecycle } from './effectiveSettingsTypes';
import { deleteByPath, getByPath } from './pathUtils';
import { settingsRegistry } from './registry';

export async function stripRegisteredLegacyLeaves(params: {
  db: LobeChatDatabase | Transaction;
  paths: string[];
  userId: string;
}): Promise<void> {
  if (params.paths.length === 0) return;
  const userModel = new UserModel(params.db as LobeChatDatabase, params.userId);
  const row = await userModel.getUserSettings();
  if (!row) return;

  const touchedTops = new Set<string>();
  for (const path of params.paths) {
    const top = path.split('.')[0];
    if (top && top !== 'keyVaults') touchedTops.add(top);
  }
  if (touchedTops.size === 0) return;

  // Build a full top-level snapshot for the columns we will rewrite.
  let tree: Record<string, unknown> = {};
  for (const top of touchedTops) {
    tree[top] = (row as Record<string, unknown>)[top];
  }
  for (const path of params.paths) {
    tree = deleteByPath(tree, path);
  }

  const patch: Record<string, unknown> = {};
  for (const top of touchedTops) {
    patch[top] = tree[top] ?? null;
  }
  await userModel.updateSetting(patch as Parameters<UserModel['updateSetting']>[0]);
}

/**
 * Copy registered legacy leaves into `user_setting_overrides` when no override exists.
 * Strips those leaves from the caller's legacy blob in DB after insert so a later
 * reset does not re-materialize the same preference.
 */
export async function backfillRegisteredLegacyOverrides(params: {
  db: LobeChatDatabase;
  legacyUserSettings: Record<string, unknown>;
  lifecycle: SettingsMutationLifecycle;
  overrides: Record<string, { value: unknown }>;
  userId: string;
}): Promise<{ overrides: Record<string, { value: unknown }>; revision: number } | null> {
  const ops: Array<{ path: string; value: unknown }> = [];
  for (const entry of settingsRegistry.list()) {
    if (params.overrides[entry.path]) continue;
    if (settingsRegistry.isSecretPath(entry.path)) continue;
    const leaf = getByPath(params.legacyUserSettings, entry.path);
    if (leaf === undefined) continue;
    const validated = settingsRegistry.validateValue(entry.path, leaf);
    if (!validated.ok) continue;
    ops.push({ path: entry.path, value: validated.value });
  }
  if (ops.length === 0) return null;

  const migrated = await params.db.transaction(async (tx) => {
    const { insertedPaths, revision } = await new PlatformSettingsModel(
      tx,
    ).insertUserOverridesIfAbsent({
      alreadyInTransaction: true,
      ops,
      source: 'legacy_migration',
      userId: params.userId,
    });
    if (insertedPaths.length === 0) return null;
    await params.lifecycle.beforeLegacyBackfillCleanup?.();
    await stripRegisteredLegacyLeaves({
      db: tx,
      paths: insertedPaths,
      userId: params.userId,
    });
    return { insertedPaths, revision };
  });
  if (!migrated) return null;
  const { insertedPaths, revision } = migrated;

  const nextOverrides = { ...params.overrides };
  for (const path of insertedPaths) {
    const op = ops.find((item) => item.path === path);
    if (op) nextOverrides[path] = { value: op.value };
  }

  return { overrides: nextOverrides, revision };
}
