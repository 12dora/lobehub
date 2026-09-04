/**
 * Finite server-owned settings registry (M05).
 *
 * Only non-secret UserSettings leaf paths are eligible.
 * Explicitly excluded: keyVaults, market tokens, languageModel provider credentials,
 * and any secret-like path.
 */

import type { SettingClientSurface, SettingGroupId } from '@/types/platform/settings';

import { DEFAULT_AGENT_ENTRIES } from './registryDefaultAgent';
import { GENERAL_ENTRIES } from './registryGeneral';
import {
  IMAGE_ENTRIES,
  MEMORY_ENTRIES,
  NOTIFICATION_ENTRIES,
  TOOL_ENTRIES,
  TTS_ENTRIES,
} from './registryLeaves';
import type { Def } from './registryShared';
import { SYSTEM_AGENT_ENTRIES } from './registrySystemAgent';

export { DEFAULT_AGENT_CHAT_CONFIG_EFFORT_PATHS } from './registryDefaultAgent';
export {
  SYSTEM_AGENT_REASONING_EFFORT_LEVELS,
  systemAgentReasoningEffortSchema,
} from './registryShared';

/** Bump when registered paths / schemas change in a breaking way for cache keys. */
export const SETTINGS_REGISTRY_VERSION = 7;

/**
 * Ordered registry entries. Keep leaf paths only; no secret / credential paths.
 */
const REGISTRY_ENTRIES: readonly Def[] = [
  // ── general ──────────────────────────────────────────────
  ...GENERAL_ENTRIES,
  // ── memory ───────────────────────────────────────────────
  ...MEMORY_ENTRIES,
  // ── tool ─────────────────────────────────────────────────
  ...TOOL_ENTRIES,
  // ── image ────────────────────────────────────────────────
  ...IMAGE_ENTRIES,
  // ── tts ──────────────────────────────────────────────────
  ...TTS_ENTRIES,
  // ── notification ─────────────────────────────────────────
  ...NOTIFICATION_ENTRIES,
  // ── defaultAgent (non-secret leaves) ─────────────────────
  ...DEFAULT_AGENT_ENTRIES,
  ...SYSTEM_AGENT_ENTRIES,
];

/** Paths that must never enter the registry (defense-in-depth denylist). */
export const SETTINGS_SECRET_PATH_PREFIXES = ['keyVaults', 'market', 'languageModel'] as const;

/** Fail closed at module load on bad registry metadata. */
const assertRegistryValid = (entries: readonly Def[]) => {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      throw new Error(`Duplicate settings registry path: ${entry.path}`);
    }
    seen.add(entry.path);
    if (entry.sensitivity === 'secret') {
      throw new Error(`Secret path must not be registered: ${entry.path}`);
    }
    if (!entry.path || entry.path.includes('..')) {
      throw new Error(`Invalid settings path: ${entry.path}`);
    }
    if (entry.builtInDefault !== undefined) {
      const parsed = entry.schema.safeParse(entry.builtInDefault);
      if (!parsed.success) {
        throw new Error(
          `Invalid built-in default for ${entry.path}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        );
      }
    }
    if (entry.applicableClients.length === 0) {
      throw new Error(`applicableClients empty for ${entry.path}`);
    }
    if (
      entry.userControlSurface.kind === 'surface' &&
      !entry.userControlSurface.surfaceFile.startsWith('src/')
    ) {
      throw new Error(`Invalid user control surface for ${entry.path}`);
    }
    if (
      entry.userControlSurface.kind === 'none' &&
      entry.userControlSurface.reason.trim().length === 0
    ) {
      throw new Error(`Missing user control omission reason for ${entry.path}`);
    }
    if (entry.lockVisibly && !entry.platformPolicyEligible) {
      throw new Error(`lockVisibly requires platformPolicyEligible: ${entry.path}`);
    }
  }
};

assertRegistryValid(REGISTRY_ENTRIES);

const byPath = new Map<string, Def>(REGISTRY_ENTRIES.map((e) => [e.path, e]));

/**
 * Stable, side-effect-free canonical view for ordinary-user control coverage.
 * Tests consume this instead of maintaining an independently editable path list.
 */
export const SETTINGS_USER_CONTROL_SURFACE_COVERAGE = Object.freeze(
  REGISTRY_ENTRIES.map(({ path, userControlSurface }) =>
    Object.freeze({ path, userControlSurface }),
  ),
);

export class SettingsRegistry {
  readonly version = SETTINGS_REGISTRY_VERSION;

  list = (): readonly Def[] => REGISTRY_ENTRIES;

  listByGroup = (group: SettingGroupId): readonly Def[] =>
    REGISTRY_ENTRIES.filter((e) => e.group === group);

  get = (path: string): Def | undefined => byPath.get(path);

  has = (path: string): boolean => byPath.has(path);

  /** Locked policies for these paths stay visible (greyed out) instead of hidden. */
  isLockVisiblyPath = (path: string): boolean => this.get(path)?.lockVisibly === true;

  isSecretPath = (path: string): boolean => {
    if (!path) return true;
    return SETTINGS_SECRET_PATH_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}.`),
    );
  };

  /**
   * Fail-closed path gate. Returns a stable business code string or null when ok.
   */
  assertPathWritable = (params: {
    path: string;
    client?: SettingClientSurface;
    requirePlatformEligible?: boolean;
  }):
    | 'MANAGED_SETTING_UNKNOWN_PATH'
    | 'MANAGED_SETTING_SECRET_PATH'
    | 'MANAGED_SETTING_INAPPLICABLE_CLIENT'
    | 'MANAGED_SETTING_NOT_POLICY_ELIGIBLE'
    | null => {
    const { path, client, requirePlatformEligible } = params;

    if (this.isSecretPath(path)) return 'MANAGED_SETTING_SECRET_PATH';

    const entry = this.get(path);
    if (!entry) return 'MANAGED_SETTING_UNKNOWN_PATH';

    if (entry.sensitivity === 'secret' || entry.sensitivity === 'sensitive') {
      return 'MANAGED_SETTING_SECRET_PATH';
    }

    if (requirePlatformEligible && !entry.platformPolicyEligible) {
      return 'MANAGED_SETTING_NOT_POLICY_ELIGIBLE';
    }

    if (client && entry.applicableClients.length > 0 && !entry.applicableClients.includes(client)) {
      return 'MANAGED_SETTING_INAPPLICABLE_CLIENT';
    }

    return null;
  };

  validateValue = (
    path: string,
    value: unknown,
  ): { ok: true; value: unknown } | { ok: false; message: string } => {
    const entry = this.get(path);
    if (!entry) return { ok: false, message: 'Unknown path' };
    const parsed = entry.schema.safeParse(value);
    if (!parsed.success) {
      return {
        ok: false,
        message: parsed.error.issues.map((i) => i.message).join('; ') || 'Invalid value',
      };
    }
    return { ok: true, value: parsed.data };
  };

  /** All registered paths (stable order). */
  paths = (): readonly string[] => REGISTRY_ENTRIES.map((e) => e.path);
}

/** Singleton registry instance. */
export const settingsRegistry = new SettingsRegistry();
