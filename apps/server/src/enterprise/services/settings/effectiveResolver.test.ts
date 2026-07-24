// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  buildSettingsCacheKey,
  resolveEffectiveSettings,
  resolveSettingPath,
} from './effectiveResolver';
import { settingsRegistry } from './registry';

describe('resolveSettingPath', () => {
  const builtin = 14;

  it('mode=user: no override → built-in', () => {
    const r = resolveSettingPath({
      builtInDefault: builtin,
      path: 'general.fontSize',
      policy: { mode: 'user', schemaVersion: 1, value: 18, visibility: 'visible' },
      userOverride: null,
    });
    expect(r.effectiveValue).toBe(14);
    expect(r.source).toBe('builtin');
    expect(r.locked).toBe(false);
    expect(r.canOverride).toBe(true);
  });

  it('mode=user: explicit override wins even when equal to default', () => {
    const r = resolveSettingPath({
      builtInDefault: builtin,
      path: 'general.fontSize',
      policy: { mode: 'user', schemaVersion: 1, value: null, visibility: 'visible' },
      userOverride: { value: 14 },
    });
    expect(r.effectiveValue).toBe(14);
    expect(r.source).toBe('user');
  });

  it('mode=user: no platform policy required', () => {
    const r = resolveSettingPath({
      builtInDefault: builtin,
      path: 'general.fontSize',
      policy: null,
      userOverride: { value: 16 },
    });
    expect(r.effectiveValue).toBe(16);
    expect(r.source).toBe('user');
    expect(r.mode).toBe('user');
  });

  it('mode=default: no override → platform value', () => {
    const r = resolveSettingPath({
      builtInDefault: builtin,
      path: 'general.fontSize',
      policy: { mode: 'default', schemaVersion: 1, value: 18, visibility: 'visible' },
      userOverride: null,
    });
    expect(r.effectiveValue).toBe(18);
    expect(r.source).toBe('platform');
    expect(r.canOverride).toBe(true);
  });

  it('mode=default: explicit override wins over platform', () => {
    const r = resolveSettingPath({
      builtInDefault: builtin,
      path: 'general.fontSize',
      policy: { mode: 'default', schemaVersion: 1, value: 18, visibility: 'visible' },
      userOverride: { value: 14 },
    });
    expect(r.effectiveValue).toBe(14);
    expect(r.source).toBe('user');
  });

  it('mode=locked: platform wins; override ignored but retained for later unlock', () => {
    const r = resolveSettingPath({
      builtInDefault: builtin,
      path: 'general.fontSize',
      policy: { mode: 'locked', schemaVersion: 1, value: 20, visibility: 'visible' },
      userOverride: { value: 12 },
    });
    expect(r.effectiveValue).toBe(20);
    expect(r.source).toBe('platform');
    expect(r.locked).toBe(true);
    expect(r.canOverride).toBe(false);
  });

  it('unlock restore: after locked→default, same override row is honored again', () => {
    const locked = resolveSettingPath({
      builtInDefault: builtin,
      path: 'general.fontSize',
      policy: { mode: 'locked', schemaVersion: 1, value: 20, visibility: 'visible' },
      userOverride: { value: 12 },
    });
    expect(locked.effectiveValue).toBe(20);

    const unlocked = resolveSettingPath({
      builtInDefault: builtin,
      path: 'general.fontSize',
      policy: { mode: 'default', schemaVersion: 1, value: 20, visibility: 'visible' },
      userOverride: { value: 12 },
    });
    expect(unlocked.effectiveValue).toBe(12);
    expect(unlocked.source).toBe('user');
  });

  it('visibility=hidden is presentation only — does not lock or drop override', () => {
    const r = resolveSettingPath({
      builtInDefault: builtin,
      path: 'general.fontSize',
      policy: { mode: 'default', schemaVersion: 1, value: 18, visibility: 'hidden' },
      userOverride: { value: 16 },
    });
    expect(r.effectiveValue).toBe(16);
    expect(r.hidden).toBe(true);
    expect(r.locked).toBe(false);
    expect(r.canOverride).toBe(true);
  });

  it('hidden + user mode still allows override', () => {
    const r = resolveSettingPath({
      builtInDefault: true,
      path: 'memory.enabled',
      policy: { mode: 'user', schemaVersion: 1, value: null, visibility: 'hidden' },
      userOverride: { value: false },
    });
    expect(r.effectiveValue).toBe(false);
    expect(r.hidden).toBe(true);
    expect(r.locked).toBe(false);
  });

  it('environment default wins over built-in when no override', () => {
    const r = resolveSettingPath({
      builtInDefault: 14,
      environmentDefault: 16,
      path: 'general.fontSize',
      policy: null,
      userOverride: null,
    });
    expect(r.effectiveValue).toBe(16);
    expect(r.source).toBe('environment');
  });

  it('platformPolicyEnabled=false ignores policy', () => {
    const r = resolveSettingPath({
      builtInDefault: 14,
      path: 'general.fontSize',
      platformPolicyEnabled: false,
      policy: { mode: 'locked', schemaVersion: 1, value: 99, visibility: 'visible' },
      userOverride: { value: 15 },
    });
    expect(r.effectiveValue).toBe(15);
    expect(r.locked).toBe(false);
    expect(r.mode).toBe('user');
  });
});

describe('resolveEffectiveSettings truth table', () => {
  it('flag OFF: legacy user_settings leaf acts as user layer; no platform', () => {
    const result = resolveEffectiveSettings({
      legacyUserSettings: { general: { fontSize: 16 } },
      platformPolicyEnabled: false,
      policies: {
        'general.fontSize': { mode: 'locked', schemaVersion: 1, value: 99, visibility: 'visible' },
      },
    });
    expect(result.effectiveValues['general.fontSize']).toBe(16);
    expect(result.pathMeta['general.fontSize']?.source).toBe('legacy');
    expect(result.pathMeta['general.fontSize']?.locked).toBe(false);
    expect(result.platformRevision).toBe(0);
  });

  it('flag OFF: no legacy → sparse empty (no built-in expansion)', () => {
    const result = resolveEffectiveSettings({
      legacyUserSettings: {},
      platformPolicyEnabled: false,
    });
    expect(result.effectiveSettings).toEqual({});
    expect(result.effectiveValues['general.fontSize']).toBeUndefined();
    expect(result.pathMeta['general.fontSize']).toBeUndefined();
  });

  it('flag ON: no override + platform default → platform value', () => {
    const result = resolveEffectiveSettings({
      platformPolicyEnabled: true,
      platformRevision: 3,
      policies: {
        'general.fontSize': { mode: 'default', schemaVersion: 1, value: 18, visibility: 'visible' },
      },
    });
    expect(result.effectiveValues['general.fontSize']).toBe(18);
    expect(result.pathMeta['general.fontSize']?.source).toBe('platform');
    expect(result.platformRevision).toBe(3);
  });

  it('flag ON: platform default change applies to users without override', () => {
    const before = resolveEffectiveSettings({
      platformPolicyEnabled: true,
      policies: {
        'memory.enabled': { mode: 'default', schemaVersion: 1, value: true, visibility: 'visible' },
      },
    });
    expect(before.effectiveValues['memory.enabled']).toBe(true);

    const after = resolveEffectiveSettings({
      platformPolicyEnabled: true,
      policies: {
        'memory.enabled': {
          mode: 'default',
          schemaVersion: 1,
          value: false,
          visibility: 'visible',
        },
      },
    });
    expect(after.effectiveValues['memory.enabled']).toBe(false);
  });

  it('flag ON: explicit equal-to-default override is still user source', () => {
    const result = resolveEffectiveSettings({
      overrides: { 'general.fontSize': { value: 14 } },
      platformPolicyEnabled: true,
      policies: {
        'general.fontSize': { mode: 'default', schemaVersion: 1, value: 14, visibility: 'visible' },
      },
    });
    expect(result.effectiveValues['general.fontSize']).toBe(14);
    expect(result.pathMeta['general.fontSize']?.source).toBe('user');
  });

  it('flag ON: locked ignores override; unlock restores', () => {
    const locked = resolveEffectiveSettings({
      overrides: { 'memory.enabled': { value: false } },
      platformPolicyEnabled: true,
      policies: {
        'memory.enabled': { mode: 'locked', schemaVersion: 1, value: true, visibility: 'visible' },
      },
    });
    expect(locked.effectiveValues['memory.enabled']).toBe(true);
    expect(locked.pathMeta['memory.enabled']?.locked).toBe(true);

    const unlocked = resolveEffectiveSettings({
      overrides: { 'memory.enabled': { value: false } },
      platformPolicyEnabled: true,
      policies: {
        'memory.enabled': { mode: 'default', schemaVersion: 1, value: true, visibility: 'visible' },
      },
    });
    expect(unlocked.effectiveValues['memory.enabled']).toBe(false);
    expect(unlocked.pathMeta['memory.enabled']?.source).toBe('user');
  });

  it('flag ON: hidden does not prevent writable override', () => {
    const result = resolveEffectiveSettings({
      overrides: { 'tts.sttAutoStop': { value: false } },
      platformPolicyEnabled: true,
      policies: {
        'tts.sttAutoStop': {
          mode: 'default',
          schemaVersion: 1,
          value: true,
          visibility: 'hidden',
        },
      },
    });
    expect(result.effectiveValues['tts.sttAutoStop']).toBe(false);
    expect(result.pathMeta['tts.sttAutoStop']?.hidden).toBe(true);
    expect(result.pathMeta['tts.sttAutoStop']?.locked).toBe(false);
  });

  it('preserves unregistered legacy keys in effectiveSettings', () => {
    const result = resolveEffectiveSettings({
      legacyUserSettings: {
        general: { fontSize: 16, customUnknown: 'keep-me' },
        someFuture: { nested: true },
      },
      platformPolicyEnabled: true,
      overrides: {},
    });
    expect((result.effectiveSettings.general as Record<string, unknown>).customUnknown).toBe(
      'keep-me',
    );
    expect(result.effectiveSettings.someFuture).toEqual({ nested: true });
  });

  it('flag ON: registered legacy leaf is user intent when no override row exists', () => {
    const result = resolveEffectiveSettings({
      legacyUserSettings: { general: { fontSize: 18 } },
      platformPolicyEnabled: true,
      policies: {
        'general.fontSize': { mode: 'default', schemaVersion: 1, value: 14, visibility: 'visible' },
      },
      overrides: {},
    });
    expect(result.effectiveValues['general.fontSize']).toBe(18);
    expect(result.pathMeta['general.fontSize']?.source).toBe('user');
  });

  it('flag ON: explicit override wins over registered legacy leaf', () => {
    const result = resolveEffectiveSettings({
      legacyUserSettings: { general: { fontSize: 18 } },
      overrides: { 'general.fontSize': { value: 12 } },
      platformPolicyEnabled: true,
      policies: {
        'general.fontSize': { mode: 'default', schemaVersion: 1, value: 14, visibility: 'visible' },
      },
    });
    expect(result.effectiveValues['general.fontSize']).toBe(12);
    expect(result.pathMeta['general.fontSize']?.source).toBe('user');
  });

  it('does not put secrets into pathMeta', () => {
    const result = resolveEffectiveSettings({
      legacyUserSettings: { keyVaults: { openai: { apiKey: 'sk-secret' } } },
      platformPolicyEnabled: true,
    });
    expect(result.pathMeta['keyVaults']).toBeUndefined();
    expect(Object.keys(result.pathMeta).some((k) => k.startsWith('keyVaults'))).toBe(false);
  });

  it('includes registry + revision metadata', () => {
    const result = resolveEffectiveSettings({
      platformPolicyEnabled: true,
      platformRevision: 7,
      userOverrideRevision: 4,
    });
    expect(result.registryVersion).toBe(settingsRegistry.version);
    expect(result.platformRevision).toBe(7);
    expect(result.userOverrideRevision).toBe(4);
  });
});

describe('settingsRegistry', () => {
  it('is a finite non-empty allowlist of non-secret paths', () => {
    const paths = settingsRegistry.paths();
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths) {
      expect(settingsRegistry.isSecretPath(path)).toBe(false);
      const entry = settingsRegistry.get(path)!;
      expect(entry.sensitivity).not.toBe('secret');
      expect(entry.platformPolicyEligible).toBe(true);
      // built-in default must satisfy schema when defined
      if (entry.builtInDefault !== undefined) {
        const v = settingsRegistry.validateValue(path, entry.builtInDefault);
        expect(v.ok).toBe(true);
      }
    }
  });

  it('rejects secret / unknown / wrong type paths fail-closed', () => {
    expect(settingsRegistry.assertPathWritable({ path: 'keyVaults.openai.apiKey' })).toBe(
      'MANAGED_SETTING_SECRET_PATH',
    );
    expect(settingsRegistry.assertPathWritable({ path: 'market.accessToken' })).toBe(
      'MANAGED_SETTING_SECRET_PATH',
    );
    expect(settingsRegistry.assertPathWritable({ path: 'languageModel.openai.apiKey' })).toBe(
      'MANAGED_SETTING_SECRET_PATH',
    );
    expect(settingsRegistry.assertPathWritable({ path: 'not.a.real.path' })).toBe(
      'MANAGED_SETTING_UNKNOWN_PATH',
    );
    expect(settingsRegistry.validateValue('general.fontSize', 'big').ok).toBe(false);
    expect(settingsRegistry.validateValue('general.fontSize', 14).ok).toBe(true);
  });

  it('rejects arbitrary JSON path and passthrough is not allowed', () => {
    expect(settingsRegistry.has('general')).toBe(false);
    expect(settingsRegistry.has('tool')).toBe(false);
    expect(settingsRegistry.validateValue('memory.effort', 'extreme').ok).toBe(false);
  });
});

describe('buildSettingsCacheKey', () => {
  it('includes registry, platform revision, user id, override revision, and legacy checksum', () => {
    expect(
      buildSettingsCacheKey({
        legacyChecksum: 'abc',
        platformRevision: 2,
        registryVersion: 1,
        userId: 'u1',
        userOverrideRevision: 0,
      }),
    ).toBe('settings:v1:p2:uu1:o0:labc');

    // Deleting last override must still change token when revision bumps
    const before = buildSettingsCacheKey({
      platformRevision: 2,
      registryVersion: 1,
      userId: 'u1',
      userOverrideRevision: 5,
    });
    const afterDeleteLast = buildSettingsCacheKey({
      platformRevision: 2,
      registryVersion: 1,
      userId: 'u1',
      userOverrideRevision: 6,
    });
    expect(before).not.toBe(afterDeleteLast);

    // Different legacy inputs must not share a cache key
    const withMemory = buildSettingsCacheKey({
      legacyChecksum: 'memory-only',
      platformRevision: 2,
      registryVersion: 1,
      userId: 'u1',
      userOverrideRevision: 0,
    });
    const withAgent = buildSettingsCacheKey({
      legacyChecksum: 'agent-slice',
      platformRevision: 2,
      registryVersion: 1,
      userId: 'u1',
      userOverrideRevision: 0,
    });
    expect(withMemory).not.toBe(withAgent);
  });
});
