/**
 * Ownership boundary between the Settings Policy editor and Service Model admin.
 *
 * Both surfaces share platform_settings_bundle.draft and platform_setting_policies.
 * The policy-editor TRPC path may only mutate non–service-model paths; foreign rows
 * must be preserved server-side (never rely on the client to carry them forward).
 *
 * Keep in sync with client:
 * `src/enterprise/client/features/admin/settings/settingsPolicyController.ts`
 */

import type { SettingsDraftPolicyMap } from '@/database/models/platform';

import { settingsRegistry } from './registry';

/** Groups wholly owned by /admin/ai/service-model. */
export const SERVICE_MODEL_MANAGED_GROUPS = new Set(['image', 'systemAgent']);

/** Leaf paths owned by service-model even when their group is shared (e.g. defaultAgent). */
export const SERVICE_MODEL_MANAGED_PATHS = new Set([
  'defaultAgent.config.model',
  'defaultAgent.config.provider',
  'tts.openAI.ttsModel',
]);

/**
 * True when the path is owned by service-model administration (not the policy editor).
 * Unknown paths fall back to group/prefix heuristics so historical rows stay protected.
 */
export const isServiceModelManagedPath = (path: string): boolean => {
  if (SERVICE_MODEL_MANAGED_PATHS.has(path)) return true;
  if (path.startsWith('image.') || path.startsWith('systemAgent.')) return true;
  const entry = settingsRegistry.get(path);
  return entry ? SERVICE_MODEL_MANAGED_GROUPS.has(entry.group) : false;
};

/**
 * Merge a policy-editor save into the authoritative draft.
 * - Owned paths: incoming is authoritative (including omissions = clear owned overrides).
 * - Foreign paths: always taken from `current` byte-for-byte; incoming foreign keys ignored.
 */
export const mergePolicyEditorDraft = (
  current: SettingsDraftPolicyMap,
  incoming: SettingsDraftPolicyMap,
): SettingsDraftPolicyMap => {
  const merged: SettingsDraftPolicyMap = {};

  for (const [path, policy] of Object.entries(current)) {
    if (isServiceModelManagedPath(path)) {
      merged[path] = policy;
    }
  }

  for (const [path, policy] of Object.entries(incoming)) {
    if (!isServiceModelManagedPath(path)) {
      merged[path] = policy;
    }
  }

  return merged;
};

type PublishedPolicyRow = {
  mode: string;
  path: string;
  schemaVersion: number;
  value: unknown;
  visibility?: string | null;
};

const toDraftPolicy = (row: PublishedPolicyRow): SettingsDraftPolicyMap[string] => ({
  mode: row.mode as SettingsDraftPolicyMap[string]['mode'],
  schemaVersion: row.schemaVersion,
  value: row.value,
  visibility: (row.visibility ?? 'visible') as SettingsDraftPolicyMap[string]['visibility'],
});

/**
 * Policy-editor publish only: re-attach foreign published rows missing from the draft
 * so an empty/partial policy-editor draft cannot delete service-model policies.
 * Full-ownership publish must not use this — omitted foreign paths are intentional deletes.
 * Paths already present in the draft (including applyImmediate updates) win.
 */
export const preserveForeignPublishedInDraft = (
  draft: SettingsDraftPolicyMap,
  published: PublishedPolicyRow[],
): SettingsDraftPolicyMap => {
  const next: SettingsDraftPolicyMap = { ...draft };
  for (const row of published) {
    if (!isServiceModelManagedPath(row.path)) continue;
    if (row.path in next) continue;
    next[row.path] = toDraftPolicy(row);
  }
  return next;
};
