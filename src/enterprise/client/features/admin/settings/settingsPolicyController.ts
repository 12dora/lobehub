/**
 * Pure controller helpers for admin settings policy UI (testable without React).
 */

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

export type DraftMap = AdminSettingsGetDraftOutput['draft'];
export type DraftPolicy = DraftMap[string];
export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

// The admin "Service model" page (/admin/ai/service-model) already owns model/service
// assignments. These groups/paths are hidden here to avoid a duplicate editing surface
// that could publish conflicting policy. Everything else in each group stays editable.
export const SERVICE_MODEL_MANAGED_GROUPS = new Set(['image', 'systemAgent']);
export const SERVICE_MODEL_MANAGED_PATHS = new Set([
  'defaultAgent.config.model',
  'defaultAgent.config.provider',
  'tts.openAI.ttsModel',
]);

export const isServiceModelManaged = (entry: { group: string; path: string }): boolean =>
  SERVICE_MODEL_MANAGED_GROUPS.has(entry.group) || SERVICE_MODEL_MANAGED_PATHS.has(entry.path);

/** Setting groups rendered on the settings policy editor (excludes service-model surfaces). */
export const SETTINGS_POLICY_GROUPS = [
  'general',
  'memory',
  'tool',
  'tts',
  'notification',
  'defaultAgent',
] as const;

/**
 * Admin UI collapses mode+visibility into two states:
 * - user: mode user + visibility visible (users control the setting)
 * - platform: mode locked + visibility hidden (admin value forced; user control hidden)
 * Runtime may still honor historical `default` via applyImmediate — do not strip server support.
 */
export type SettingsPolicyUiMode = 'platform' | 'user';

/** Historical default/locked → platform; user → user. */
export const toSettingsPolicyUiMode = (policy: {
  mode: string;
  visibility?: string;
}): SettingsPolicyUiMode => (policy.mode === 'user' ? 'user' : 'platform');

/** Canonical write form for the two-state UI. */
export const fromSettingsPolicyUiMode = (
  mode: SettingsPolicyUiMode,
): Pick<DraftPolicy, 'mode' | 'visibility'> =>
  mode === 'platform'
    ? { mode: 'locked', visibility: 'hidden' }
    : { mode: 'user', visibility: 'visible' };

/**
 * Normalize draft entries for the two-state policy UI (legacy default/locked → locked+hidden).
 * Pass `preservePath` for foreign rows (service-model) so they stay byte-identical — the
 * policy editor must never rewrite hidden ownership belonging to another admin surface.
 */
export const normalizeSettingsPolicyDraft = (
  draft: DraftMap,
  options?: { preservePath?: (path: string) => boolean },
): DraftMap =>
  Object.fromEntries(
    Object.entries(draft).map(([path, policy]) => {
      if (!policy) return [path, policy];
      if (options?.preservePath?.(path)) return [path, policy];
      const ui = toSettingsPolicyUiMode(policy);
      return [path, { ...policy, ...fromSettingsPolicyUiMode(ui) }];
    }),
  ) as DraftMap;

/** Project only policy-editor-owned paths for save/publish payloads (server re-attaches foreign). */
export const projectPolicyEditorOwnedDraft = (
  draft: DraftMap,
  isForeignPath: (path: string) => boolean,
): DraftMap =>
  Object.fromEntries(
    Object.entries(normalizeSettingsPolicyDraft(draft, { preservePath: isForeignPath })).filter(
      ([path]) => !isForeignPath(path),
    ),
  ) as DraftMap;

export type SettingsPermissionMode = {
  canPublish: boolean;
  canUpdate: boolean;
  canView: boolean;
};

export const deriveSettingsPermissions = (
  permissions: readonly string[],
): SettingsPermissionMode => {
  const set = new Set(permissions);
  return {
    canPublish: set.has(PLATFORM_PERMISSIONS.SETTINGS_PUBLISH),
    canUpdate: set.has(PLATFORM_PERMISSIONS.SETTINGS_UPDATE),
    canView: set.has(PLATFORM_PERMISSIONS.SETTINGS_READ),
  };
};

export type PolicyDiffRow = {
  afterMode: string;
  afterValue: unknown;
  afterVisibility: string;
  beforeMode: string;
  beforeValue: unknown;
  beforeVisibility: string;
  changed: boolean;
  path: string;
};

export const buildChangePreview = (params: {
  draft: DraftMap;
  published: DraftMap;
  registryPaths: string[];
}): PolicyDiffRow[] => {
  const paths = new Set([...params.registryPaths, ...Object.keys(params.draft)]);
  const rows: PolicyDiffRow[] = [];
  for (const path of [...paths].sort()) {
    const d = params.draft[path];
    const p = params.published[path];
    const beforeMode = p?.mode ?? 'user';
    const afterMode = d?.mode ?? beforeMode;
    const beforeVis = p?.visibility ?? 'visible';
    const afterVis = d?.visibility ?? beforeVis;
    const beforeValue = p?.value;
    const afterValue = d?.value ?? beforeValue;
    const changed =
      beforeMode !== afterMode ||
      beforeVis !== afterVis ||
      JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
    if (!changed && !d) continue;
    rows.push({
      afterMode,
      afterValue,
      afterVisibility: afterVis,
      beforeMode,
      beforeValue,
      beforeVisibility: beforeVis,
      changed,
      path,
    });
  }
  return rows.filter((r) => r.changed);
};
