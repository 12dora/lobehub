/**
 * Platform settings policy types (M05).
 *
 * Control mode and presentation visibility are separate:
 * - mode: who wins at resolve time (`user` | `default` | `locked`)
 * - visibility: whether the control is shown (`visible` | `hidden`)
 *
 * `hidden` never silently locks or deletes overrides by itself.
 */

import type { z } from 'zod';

/** Control mode — independent of UI visibility. */
export type SettingPolicyMode = 'user' | 'default' | 'locked';

/** Presentation-only visibility. Does not change resolve winner by itself. */
export type SettingPolicyVisibility = 'visible' | 'hidden';

/** Where the effective value came from. */
export type SettingValueSource = 'builtin' | 'environment' | 'platform' | 'user' | 'legacy';

/** Sensitivity class — secret paths are never registry-eligible. */
export type SettingSensitivity = 'public' | 'internal' | 'sensitive' | 'secret';

/** Client / surface applicability. */
export type SettingClientSurface = 'web' | 'desktop' | 'mobile' | 'server';

/** Control widget hint for admin / user UI. */
export type SettingControlType =
  'switch' | 'select' | 'number' | 'text' | 'slider' | 'color' | 'textarea';

/** Registry entry — server-owned, finite allowlist. */
export interface SettingDefinition<T = unknown> {
  /** Surfaces where this path applies. Empty = all. */
  applicableClients: readonly SettingClientSurface[];
  /** Built-in default value (must pass schema). */
  builtInDefault: T;
  /** UI control hint. */
  control: SettingControlType;
  /** i18n description key (admin namespace or setting namespace). */
  descriptionKey: string;
  /** Group for admin UI clustering. */
  group: SettingGroupId;
  max?: number;
  /** Optional numeric bounds for number/slider. */
  min?: number;
  /** Select options when control === 'select'. */
  options?: ReadonlyArray<{ labelKey: string; value: string | number | boolean }>;
  /** Stable path, e.g. `general.fontSize`. */
  path: string;
  /** Whether this path may appear in platform policies (admin defaults/locks). */
  platformPolicyEligible: boolean;
  /** Zod schema — strict, no passthrough. */
  schema: z.ZodType<T>;
  /** Schema version for this definition (bump on breaking schema change). */
  schemaVersion: number;
  /** Sensitivity — secret entries must not be registered. */
  sensitivity: SettingSensitivity;
  step?: number;
  /** i18n title key. */
  titleKey: string;
}

export type SettingGroupId =
  'general' | 'memory' | 'tool' | 'image' | 'tts' | 'notification' | 'defaultAgent' | 'systemAgent';

/** Published / draft policy for a single registered path. */
export interface SettingPathPolicy {
  mode: SettingPolicyMode;
  path: string;
  schemaVersion: number;
  value: unknown;
  visibility: SettingPolicyVisibility;
}

/** Explicit user override row intent (row existence === explicit). */
export interface SettingPathOverride {
  /** Always true when row exists — kept for clarity in resolver inputs. */
  exists: true;
  path: string;
  updatedAt?: string;
  value: unknown;
}

/** Per-path metadata returned with effective settings. */
export interface EffectiveSettingPathMeta {
  canOverride: boolean;
  hidden: boolean;
  locked: boolean;
  mode: SettingPolicyMode;
  path: string;
  schemaVersion: number;
  source: SettingValueSource;
  visibility: SettingPolicyVisibility;
}

/** Aggregate settings resource identity (revision pointer). */
export const PLATFORM_SETTINGS_RESOURCE_TYPE = 'settings' as const;
export const PLATFORM_SETTINGS_RESOURCE_ID = 'global' as const;

/** Draft / published settings bundle (aggregate). */
export interface SettingsPolicyBundle {
  /** Map of path → policy. Only registered paths allowed. */
  policies: Record<string, Omit<SettingPathPolicy, 'path'>>;
  /** Registry version the bundle was validated against. */
  registryVersion: number;
}

export interface EffectiveSettingsResult {
  /** Nested effective UserSettings-shaped object (non-secret keys only + passthrough legacy). */
  effectiveSettings: Record<string, unknown>;
  /** Flat path → effective value for registered paths. */
  effectiveValues: Record<string, unknown>;
  /** Per registered path metadata. */
  pathMeta: Record<string, EffectiveSettingPathMeta>;
  /** Published platform settings revision (0 when none / flag off). */
  platformRevision: number;
  /** Registry version used for this resolve. */
  registryVersion: number;
  /** Monotonic user-scoped override revision token. */
  userOverrideRevision: number;
}

/** Admin draft payload shape. */
export interface SettingsDraftPayload {
  baseRevision: number;
  policies: Record<
    string,
    {
      mode: SettingPolicyMode;
      schemaVersion: number;
      value: unknown;
      visibility: SettingPolicyVisibility;
    }
  >;
  registryVersion: number;
}

/** Validation issue for draft / patch. */
export interface SettingsValidationIssue {
  code: string;
  message: string;
  path: string;
}

export interface SettingsValidationResult {
  /** Estimated users with an override on paths that would change under lock/default. */
  impactEstimate?: {
    pathsWithOverrides: number;
    totalOverrideRows: number;
  };
  issues: SettingsValidationIssue[];
  ok: boolean;
}
