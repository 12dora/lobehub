import type {
  SettingPathOverride,
  SettingPathPolicy,
  SettingPolicyMode,
  SettingPolicyVisibility,
  SettingValueSource,
} from '@/types/platform/settings';

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

const userModeResult = (
  effectiveValue: unknown,
  source: SettingValueSource,
  hidden: boolean,
  schemaVersion: number,
  visibility: SettingPolicyVisibility,
): ResolvePathResult => ({
  canOverride: true,
  effectiveValue,
  hidden,
  locked: false,
  mode: 'user',
  schemaVersion,
  source,
  visibility,
});

/**
 * Resolve a single registered path.
 * Pure function — no I/O.
 */
export function resolveSettingPath(input: ResolvePathInput): ResolvePathResult {
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
      return userModeResult(input.userOverride!.value, 'user', hidden, schemaVersion, visibility);
    }
    return userModeResult(base, baseSource, hidden, schemaVersion, visibility);
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
}
