/**
 * Pure controller helpers for admin settings policy UI (testable without React).
 */

import { EFFORT_CONTROL_KEYS } from '@lobechat/model-runtime';

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
  // Path-by-path: do not prefix-own `defaultAgent.config.chatConfig.*` or
  // enableStreaming / historyCount would leave the policy editor.
  ...EFFORT_CONTROL_KEYS.map((key) => `defaultAgent.config.chatConfig.${key}`),
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
 * Paths that stay on screen when locked, rendered read-only with the enforced value.
 *
 * Hiding a lock is the right default — a control nobody can move is noise. But a privacy
 * promise is different: if the org turns anonymous telemetry off, users must be able to see
 * that it is off, otherwise the only signal left is the wizard's opt-in copy, which now
 * describes something that will never happen.
 */
export const LOCK_VISIBLE_PATHS = new Set(['general.telemetry']);

export const isLockVisiblePath = (path: string): boolean => LOCK_VISIBLE_PATHS.has(path);

/**
 * Admin UI exposes the three runtime tiers 1:1 with the stored policy mode:
 * - user:    mode user + visibility visible — users own the setting; the platform value is unused
 * - default: mode default + visibility visible — platform value pre-fills, users may still change it
 * - locked:  mode locked + visibility hidden — platform value is enforced and the control is hidden
 *            (except for `LOCK_VISIBLE_PATHS`, which stay visible but greyed out)
 *
 * The UI mode intentionally mirrors `SettingPolicyMode` so nothing is lost on a
 * load → edit → save round-trip (an admin-published `default` must survive `save`).
 */
export const SETTINGS_POLICY_UI_MODES = ['user', 'default', 'locked'] as const;

export type SettingsPolicyUiMode = (typeof SETTINGS_POLICY_UI_MODES)[number];

/**
 * Label keys per tier. `locked` keeps the historical `uiMode.platform` key so the
 * existing "Platform managed / 平台托管" translations stay in every locale.
 */
export const SETTINGS_POLICY_UI_MODE_LABEL_KEYS: Record<SettingsPolicyUiMode, string> = {
  default: 'settingsPolicy.uiMode.default',
  locked: 'settingsPolicy.uiMode.platform',
  user: 'settingsPolicy.uiMode.user',
};

/** One-line semantics per tier, so the active tier is never ambiguous. */
export const SETTINGS_POLICY_UI_MODE_HINT_KEYS: Record<SettingsPolicyUiMode, string> = {
  default: 'settingsPolicy.uiMode.hint.default',
  locked: 'settingsPolicy.uiMode.hint.platform',
  user: 'settingsPolicy.uiMode.hint.user',
};

/** Lock-visible paths hide nothing, so the generic "hidden from users" hint would be wrong. */
export const settingsPolicyUiModeHintKey = (mode: SettingsPolicyUiMode, path: string): string =>
  mode === 'locked' && isLockVisiblePath(path)
    ? 'settingsPolicy.uiMode.hint.platformVisible'
    : SETTINGS_POLICY_UI_MODE_HINT_KEYS[mode];

/** The platform value only matters for the two tiers that publish one. */
export const settingsPolicyUiModeUsesValue = (mode: SettingsPolicyUiMode): boolean =>
  mode !== 'user';

/** Stored mode → UI tier. Unknown modes fail closed to the strictest tier. */
export const toSettingsPolicyUiMode = (policy: {
  mode: string;
  visibility?: string;
}): SettingsPolicyUiMode => {
  if (policy.mode === 'user') return 'user';
  if (policy.mode === 'default') return 'default';
  return 'locked';
};

/** Canonical write form for each tier. */
export const fromSettingsPolicyUiMode = (
  mode: SettingsPolicyUiMode,
  path?: string,
): Pick<DraftPolicy, 'mode' | 'visibility'> => {
  if (mode === 'locked')
    return {
      mode: 'locked',
      visibility: path && isLockVisiblePath(path) ? 'visible' : 'hidden',
    };
  if (mode === 'default') return { mode: 'default', visibility: 'visible' };
  return { mode: 'user', visibility: 'visible' };
};

/**
 * Canonicalize draft entries to the tier form (mode → its paired visibility). `default`
 * is preserved — rewriting it to locked would silently take a setting away from users.
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
      return [path, { ...policy, ...fromSettingsPolicyUiMode(ui, path) }];
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
