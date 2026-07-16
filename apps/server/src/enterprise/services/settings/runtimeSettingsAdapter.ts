/**
 * Single adapter for server-side settings reads that must go through the resolver.
 *
 * When ENABLE_PLATFORM_SETTINGS_POLICY is off, returns the legacy partial as-is
 * (callers continue to merge with built-ins as today).
 *
 * When on, returns server-resolved effective settings so client and server
 * never independently merge platform policy.
 *
 * keyVaults is never taken from the resolver pathMeta — pass encrypted vaults
 * through separately if needed.
 */

import type { LobeChatDatabase } from '@/database/type';
import type { EffectiveSettingsResult } from '@/types/platform/settings';

import { EffectiveSettingsService } from './effectiveSettingsService';

/**
 * Registered runtime read entry points that must use this adapter when the flag is ON.
 * Static tests assert new entries import this module rather than reading raw user_settings alone.
 */
export const SETTINGS_RUNTIME_READ_REGISTRY = [
  'userRouter.getUserState',
  'userRouter.getEffectiveSettings',
  'runtimeSettingsAdapter.loadEffectiveUserSettings',
  // Domain readers that should prefer effective defaults for model/system-agent/tool:
  'runtimeSettingsAdapter.getDefaultAgentSlice',
  'runtimeSettingsAdapter.getSystemAgentSlice',
  'runtimeSettingsAdapter.getToolSlice',
] as const;

export type SettingsRuntimeReadId = (typeof SETTINGS_RUNTIME_READ_REGISTRY)[number];

export interface LoadEffectiveUserSettingsParams {
  db: LobeChatDatabase;
  /**
   * Legacy partial from user_settings (may include keyVaults).
   * keyVaults is preserved on the returned object when present; never rewritten by policy.
   */
  legacySettings?: Record<string, unknown> | null;
  userId: string;
}

/**
 * Resolve settings for runtime use. Always safe to call — flag OFF is a no-op merge layer.
 */
export const loadEffectiveUserSettings = async (
  params: LoadEffectiveUserSettingsParams,
): Promise<{
  effective: EffectiveSettingsResult;
  /** Settings object safe for UserInitializationState.settings (includes keyVaults if provided). */
  settings: Record<string, unknown>;
}> => {
  const service = new EffectiveSettingsService(params.db);
  const legacy: Record<string, unknown> = { ...params.legacySettings };
  const keyVaults = legacy.keyVaults;
  delete legacy.keyVaults;

  const effective = await service.getEffectiveSettings({
    legacyUserSettings: legacy,
    userId: params.userId,
  });

  const settings: Record<string, unknown> = {
    ...effective.effectiveSettings,
  };

  // Preserve encrypted keyVaults outside platform policy semantics
  if (keyVaults !== undefined) {
    settings.keyVaults = keyVaults;
  }

  return { effective, settings };
};

export const getDefaultAgentSlice = async (
  params: LoadEffectiveUserSettingsParams,
): Promise<unknown> => {
  const { settings } = await loadEffectiveUserSettings(params);
  return settings.defaultAgent;
};

export const getSystemAgentSlice = async (
  params: LoadEffectiveUserSettingsParams,
): Promise<unknown> => {
  const { settings } = await loadEffectiveUserSettings(params);
  return settings.systemAgent;
};

export const getToolSlice = async (params: LoadEffectiveUserSettingsParams): Promise<unknown> => {
  const { settings } = await loadEffectiveUserSettings(params);
  return settings.tool;
};
