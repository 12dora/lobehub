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

export type { ResolveAllSettingsInput } from './effectiveResolveAll';
export { resolveEffectiveSettings } from './effectiveResolveAll';
export type { ResolvePathInput, ResolvePathResult } from './effectiveResolvePath';
export { resolveSettingPath } from './effectiveResolvePath';

/**
 * Cache key material for multi-instance correctness.
 * Consumers must combine with invalidation events; process-local Maps are only a soft cache.
 *
 * `legacyChecksum` must cover the caller's sanitized legacy input so partial-slice
 * adapters cannot reuse a materialization built from a different legacy blob.
 */
export const buildSettingsCacheKey = (params: {
  legacyChecksum?: string;
  registryVersion: number;
  platformRevision: number;
  userId: string;
  userOverrideRevision: number;
}): string =>
  `settings:v${params.registryVersion}:p${params.platformRevision}:u${params.userId}:o${params.userOverrideRevision}:l${params.legacyChecksum ?? '0'}`;
