import type {
  EffectiveSettingPathMeta,
  EffectiveSettingsResult,
  SettingPathPolicy,
  SettingValueSource,
} from '@/types/platform/settings';

import { resolveSettingPath } from './effectiveResolvePath';
import { getByPath, setByPath } from './pathUtils';
import { SETTINGS_REGISTRY_VERSION, type SettingsRegistry, settingsRegistry } from './registry';

export interface ResolveAllSettingsInput {
  /** Optional env defaults keyed by path. */
  environmentDefaults?: Record<string, unknown>;
  /**
   * Legacy partial user_settings blob (deep partial).
   * When flag is OFF, this is the only user layer.
   * When flag is ON, registered paths prefer override rows; a legacy leaf fills a
   * registered path only when no override row exists (pre-policy user intent),
   * and still fills unregistered keys.
   */
  legacyUserSettings?: Record<string, unknown> | null;
  /** Explicit override rows keyed by path. */
  overrides?: Record<string, { value: unknown }>;
  /**
   * When false, ignore platform policies and use legacy merge only for registered paths
   * (built-in + legacy partial settings). Unregistered legacy keys still pass through.
   */
  platformPolicyEnabled: boolean;
  /** Platform published revision (for cache metadata). */
  platformRevision?: number;
  /** Published platform policies keyed by path. */
  policies?: Record<
    string,
    Pick<SettingPathPolicy, 'mode' | 'value' | 'visibility' | 'schemaVersion'>
  >;
  registry?: SettingsRegistry;
  /** Monotonic user override revision token. */
  userOverrideRevision?: number;
}

function resolveFlagOffEffectiveSettings(
  registry: SettingsRegistry,
  legacy: Record<string, unknown>,
): EffectiveSettingsResult {
  const effectiveValues: Record<string, unknown> = {};
  const pathMeta: Record<string, EffectiveSettingPathMeta> = {};
  for (const entry of registry.list()) {
    const leaf = getByPath(legacy, entry.path);
    if (leaf === undefined) continue;
    effectiveValues[entry.path] = leaf;
    pathMeta[entry.path] = {
      canOverride: true,
      hidden: false,
      locked: false,
      mode: 'user',
      path: entry.path,
      schemaVersion: entry.schemaVersion,
      source: 'legacy',
      visibility: 'visible',
    };
  }
  return {
    effectiveSettings: { ...legacy },
    effectiveValues,
    pathMeta,
    platformRevision: 0,
    registryVersion: registry.version ?? SETTINGS_REGISTRY_VERSION,
    userOverrideRevision: 0,
  };
}

/**
 * Prefer explicit override rows. When absent, a pre-policy legacy leaf is
 * treated as user intent so enabling the flag does not silently reset preferences.
 */
export function resolvePathUserOverride(
  override: { value: unknown } | undefined,
  legacy: Record<string, unknown>,
  path: string,
): { value: unknown } | null {
  const legacyLeaf = override ? undefined : getByPath(legacy, path);
  if (override) return { value: override.value };
  if (legacyLeaf !== undefined) return { value: legacyLeaf };
  return null;
}

function resolveFlagOnEffectiveSettings(
  input: ResolveAllSettingsInput,
  registry: SettingsRegistry,
  legacy: Record<string, unknown>,
): EffectiveSettingsResult {
  const policies = input.policies ?? {};
  const overrides = input.overrides ?? {};
  const envDefaults = input.environmentDefaults ?? {};
  const flagOn = input.platformPolicyEnabled;

  // Start from legacy blob (shallow clone of top-level) so unregistered keys pass through
  let effectiveSettings: Record<string, unknown> = { ...legacy };

  const effectiveValues: Record<string, unknown> = {};
  const pathMeta: Record<string, EffectiveSettingPathMeta> = {};

  for (const entry of registry.list()) {
    const path = entry.path;
    const policy = policies[path];
    const override = overrides[path];
    const userOverride = resolvePathUserOverride(override, legacy, path);

    const resolved = resolveSettingPath({
      builtInDefault: entry.builtInDefault,
      environmentDefault: envDefaults[path],
      path,
      platformPolicyEnabled: true,
      policy: policy ?? null,
      userOverride,
    });

    const source: SettingValueSource = resolved.source;

    pathMeta[path] = {
      canOverride: resolved.canOverride,
      hidden: resolved.hidden,
      locked: resolved.locked,
      mode: resolved.mode,
      path,
      schemaVersion: resolved.schemaVersion,
      source,
      visibility: resolved.visibility,
    };

    // Skip unset optionals: no own-property in effectiveValues and no nested write.
    if (resolved.effectiveValue !== undefined) {
      effectiveValues[path] = resolved.effectiveValue;
      effectiveSettings = setByPath(effectiveSettings, path, resolved.effectiveValue);
    }
  }

  // Never surface keyVaults in effective settings source maps; strip accidental registry bleed
  if ('keyVaults' in pathMeta) {
    delete pathMeta['keyVaults'];
  }

  return {
    effectiveSettings,
    effectiveValues,
    pathMeta,
    platformRevision: flagOn ? (input.platformRevision ?? 0) : 0,
    registryVersion: registry.version ?? SETTINGS_REGISTRY_VERSION,
    userOverrideRevision: input.userOverrideRevision ?? 0,
  };
}

/**
 * Resolve all registered paths + merge unregistered legacy keys.
 * Never includes keyVaults secrets in pathMeta/source maps.
 */
export function resolveEffectiveSettings(input: ResolveAllSettingsInput): EffectiveSettingsResult {
  const registry = input.registry ?? settingsRegistry;
  const legacy = (input.legacyUserSettings ?? {}) as Record<string, unknown>;

  /**
   * Flag OFF: exact sparse legacy pass-through — do NOT expand built-in registry defaults
   * into the settings object (parent getUserState / runtime parity).
   */
  if (!input.platformPolicyEnabled) {
    return resolveFlagOffEffectiveSettings(registry, legacy);
  }

  return resolveFlagOnEffectiveSettings(input, registry, legacy);
}
