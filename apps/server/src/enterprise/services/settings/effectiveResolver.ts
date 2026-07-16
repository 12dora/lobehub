/**
 * Pure Effective Configuration Resolver (M05).
 *
 * Semantics:
 * - mode=user:    built-in (+ env) base; explicit user override wins
 * - mode=default: platform value is base; explicit user override wins
 * - mode=locked:  platform value wins; override row retained but ignored at runtime
 * - visibility=hidden: presentation only — never locks / deletes / rejects by itself
 * - Override row existence = explicit intent even when value equals default
 * - Flag OFF: built-in + legacy user_settings only (no platform policies)
 */

import type {
  EffectiveSettingPathMeta,
  EffectiveSettingsResult,
  SettingPathOverride,
  SettingPathPolicy,
  SettingPolicyMode,
  SettingPolicyVisibility,
  SettingValueSource,
} from '@/types/platform/settings';

import { getByPath, setByPath } from './pathUtils';
import { SETTINGS_REGISTRY_VERSION, type SettingsRegistry, settingsRegistry } from './registry';

export interface ResolvePathInput {
  builtInDefault: unknown;
  /** Optional environment / bootstrap default (wins over built-in when present). */
  environmentDefault?: unknown;
  path: string;
  /** When false, ignore platform policy entirely. */
  platformPolicyEnabled?: boolean;
  policy?: Pick<SettingPathPolicy, 'mode' | 'value' | 'visibility' | 'schemaVersion'> | null;
  /**
   * Explicit override. Pass `null`/`undefined` when no row.
   * Presence of the object means explicit intent — even if value equals default.
   */
  userOverride?: Pick<SettingPathOverride, 'value'> | null;
}

export interface ResolvePathResult {
  canOverride: boolean;
  effectiveValue: unknown;
  hidden: boolean;
  locked: boolean;
  mode: SettingPolicyMode;
  schemaVersion: number;
  source: SettingValueSource;
  visibility: SettingPolicyVisibility;
}

const MISSING = Symbol('missing');

const hasEnvDefault = (v: unknown): boolean => v !== undefined && v !== MISSING;

/**
 * Resolve a single registered path.
 * Pure function — no I/O.
 */
export const resolveSettingPath = (input: ResolvePathInput): ResolvePathResult => {
  const platformPolicyEnabled = input.platformPolicyEnabled !== false;
  const policy = platformPolicyEnabled && input.policy ? input.policy : null;

  const mode: SettingPolicyMode = policy?.mode ?? 'user';
  const visibility: SettingPolicyVisibility = policy?.visibility ?? 'visible';
  const schemaVersion = policy?.schemaVersion ?? 1;
  const hidden = visibility === 'hidden';
  const hasOverride = input.userOverride != null;

  // Base: environment default if present, else built-in
  const base = hasEnvDefault(input.environmentDefault)
    ? input.environmentDefault
    : input.builtInDefault;
  const baseSource: SettingValueSource = hasEnvDefault(input.environmentDefault)
    ? 'environment'
    : 'builtin';

  if (!policy || mode === 'user') {
    if (hasOverride) {
      return {
        canOverride: true,
        effectiveValue: input.userOverride!.value,
        hidden,
        locked: false,
        mode: 'user',
        schemaVersion,
        source: 'user',
        visibility,
      };
    }
    return {
      canOverride: true,
      effectiveValue: base,
      hidden,
      locked: false,
      mode: 'user',
      schemaVersion,
      source: baseSource,
      visibility,
    };
  }

  if (mode === 'default') {
    if (hasOverride) {
      return {
        canOverride: true,
        effectiveValue: input.userOverride!.value,
        hidden,
        locked: false,
        mode: 'default',
        schemaVersion,
        source: 'user',
        visibility,
      };
    }
    return {
      canOverride: true,
      effectiveValue: policy!.value,
      hidden,
      locked: false,
      mode: 'default',
      schemaVersion,
      source: 'platform',
      visibility,
    };
  }

  // mode === 'locked' — platform wins; override retained but ignored
  return {
    canOverride: false,
    effectiveValue: policy!.value,
    hidden,
    locked: true,
    mode: 'locked',
    schemaVersion,
    source: 'platform',
    visibility,
  };
};

export interface ResolveAllSettingsInput {
  /** Optional env defaults keyed by path. */
  environmentDefaults?: Record<string, unknown>;
  /**
   * Legacy partial user_settings blob (deep partial).
   * When flag is OFF, this is the only user layer.
   * When flag is ON, registered paths prefer override rows; legacy fills unregistered keys.
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

/**
 * Resolve all registered paths + merge unregistered legacy keys.
 * Never includes keyVaults secrets in pathMeta/source maps.
 */
export const resolveEffectiveSettings = (
  input: ResolveAllSettingsInput,
): EffectiveSettingsResult => {
  const registry = input.registry ?? settingsRegistry;
  const policies = input.policies ?? {};
  const overrides = input.overrides ?? {};
  const legacy = (input.legacyUserSettings ?? {}) as Record<string, unknown>;
  const envDefaults = input.environmentDefaults ?? {};
  const flagOn = input.platformPolicyEnabled;

  // Start from legacy blob (shallow clone of top-level) so unregistered keys pass through
  let effectiveSettings: Record<string, unknown> = { ...legacy };
  // Strip secrets from client-visible effective settings pathMeta; keyVaults stay only if legacy had them
  // Callers that need keyVaults must load them via the dedicated encrypted path.

  const effectiveValues: Record<string, unknown> = {};
  const pathMeta: Record<string, EffectiveSettingPathMeta> = {};

  for (const entry of registry.list()) {
    const path = entry.path;
    const policy = policies[path];
    const override = overrides[path];

    // When flag ON: registered paths use override table, not legacy blob leaf
    // When flag OFF: treat legacy leaf as the "user" layer (legacy source)
    let userOverride: { value: unknown } | null = null;
    let forceLegacySource = false;

    if (flagOn) {
      userOverride = override ? { value: override.value } : null;
    } else {
      const legacyLeaf = getByPath(legacy, path);
      if (legacyLeaf !== undefined) {
        userOverride = { value: legacyLeaf };
        forceLegacySource = true;
      }
    }

    const resolved = resolveSettingPath({
      builtInDefault: entry.builtInDefault,
      environmentDefault: envDefaults[path],
      path,
      platformPolicyEnabled: flagOn,
      policy: policy ?? null,
      userOverride,
    });

    const source: SettingValueSource = forceLegacySource
      ? resolved.source === 'user'
        ? 'legacy'
        : resolved.source
      : resolved.source;

    effectiveValues[path] = resolved.effectiveValue;
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

    // Apply registered effective value into nested settings object (skip unset optionals)
    if (resolved.effectiveValue !== undefined) {
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
};

/**
 * Cache key material for multi-instance correctness.
 * Consumers must combine with invalidation events; process-local Maps are only a soft cache.
 */
export const buildSettingsCacheKey = (params: {
  registryVersion: number;
  platformRevision: number;
  userId: string;
  userOverrideRevision: number;
}): string =>
  `settings:v${params.registryVersion}:p${params.platformRevision}:u${params.userId}:o${params.userOverrideRevision}`;
