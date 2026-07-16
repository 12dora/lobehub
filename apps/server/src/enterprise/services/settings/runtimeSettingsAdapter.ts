/**
 * Single adapter for server-side settings reads that must go through the resolver.
 *
 * Flag OFF: exact parent behavior — return sparse legacy / raw DB columns with
 * zero platform table or invalidation calls.
 *
 * Flag ON: server-resolved effective settings so client and server never
 * independently merge platform policy.
 *
 * keyVaults / market secrets stay on dedicated encrypted paths.
 */

import { UserModel } from '@/database/models/user';
import type { LobeChatDatabase } from '@/database/type';
import type { EffectiveSettingsResult } from '@/types/platform/settings';

import { getEnterpriseFeatureFlags } from '../../featureFlags';
import { EffectiveSettingsService } from './effectiveSettingsService';

/**
 * Registered runtime read entry points that must use this adapter when the flag is ON.
 * Static tests also ban direct getUserSettingsDefaultAgentConfig / getUserSettings()
 * for policy-eligible slices outside allowlisted secret/market paths.
 */
export const SETTINGS_RUNTIME_READ_REGISTRY = [
  'userRouter.getUserState',
  'userRouter.getEffectiveSettings',
  'runtimeSettingsAdapter.loadEffectiveUserSettings',
  'runtimeSettingsAdapter.getEffectiveDefaultAgentConfig',
  'runtimeSettingsAdapter.getEffectiveSystemAgentConfig',
  'runtimeSettingsAdapter.getDefaultAgentSlice',
  'runtimeSettingsAdapter.getSystemAgentSlice',
  'runtimeSettingsAdapter.getToolSlice',
  'AgentService.getBuiltinAgent',
  'AgentService.getAgentConfig',
  'SystemAgentService.getTaskModelConfig',
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

const isPolicyEnabled = () => getEnterpriseFeatureFlags().ENABLE_PLATFORM_SETTINGS_POLICY;

/**
 * Resolve settings for runtime / getUserState.
 * Flag OFF: exact sparse legacy pass-through (deep-equal parent shape).
 */
export const loadEffectiveUserSettings = async (
  params: LoadEffectiveUserSettingsParams,
): Promise<{
  effective: EffectiveSettingsResult;
  /** Settings object safe for UserInitializationState.settings (includes keyVaults if provided). */
  settings: Record<string, unknown>;
}> => {
  const legacy: Record<string, unknown> = { ...params.legacySettings };

  if (!isPolicyEnabled()) {
    // Exact parent parity — no platform queries, no default expansion
    return {
      effective: {
        effectiveSettings: { ...legacy },
        effectiveValues: {},
        pathMeta: {},
        platformRevision: 0,
        registryVersion: 0,
        userOverrideRevision: 0,
      },
      settings: legacy,
    };
  }

  const service = new EffectiveSettingsService(params.db);
  const keyVaults = legacy.keyVaults;
  delete legacy.keyVaults;

  const effective = await service.getEffectiveSettings({
    legacyUserSettings: legacy,
    userId: params.userId,
  });

  const settings: Record<string, unknown> = {
    ...effective.effectiveSettings,
  };

  if (keyVaults !== undefined) {
    settings.keyVaults = keyVaults;
  }

  return { effective, settings };
};

/**
 * Effective defaultAgent row shape for AgentService merge (flag ON uses resolver).
 * Flag OFF: identical to UserModel.getUserSettingsDefaultAgentConfig().
 */
export const getEffectiveDefaultAgentConfig = async (params: {
  db: LobeChatDatabase;
  userId: string;
}): Promise<unknown> => {
  if (!isPolicyEnabled()) {
    const userModel = new UserModel(params.db, params.userId);
    return userModel.getUserSettingsDefaultAgentConfig();
  }

  const userModel = new UserModel(params.db, params.userId);
  const row = await userModel.getUserSettings();
  const legacy = {
    defaultAgent: row?.defaultAgent,
    general: row?.general,
    systemAgent: row?.systemAgent,
    tool: row?.tool,
  };
  const { settings } = await loadEffectiveUserSettings({
    db: params.db,
    legacySettings: legacy as Record<string, unknown>,
    userId: params.userId,
  });
  return settings.defaultAgent ?? null;
};

/**
 * Effective systemAgent config for SystemAgentService.
 * Flag OFF: raw getUserSettings().systemAgent (parent behavior).
 */
export const getEffectiveSystemAgentConfig = async (params: {
  db: LobeChatDatabase;
  userId: string;
}): Promise<unknown> => {
  if (!isPolicyEnabled()) {
    const userModel = new UserModel(params.db, params.userId);
    const settings = await userModel.getUserSettings();
    return settings?.systemAgent;
  }

  const userModel = new UserModel(params.db, params.userId);
  const row = await userModel.getUserSettings();
  const { settings } = await loadEffectiveUserSettings({
    db: params.db,
    legacySettings: {
      defaultAgent: row?.defaultAgent,
      systemAgent: row?.systemAgent,
      tool: row?.tool,
    } as Record<string, unknown>,
    userId: params.userId,
  });
  return settings.systemAgent;
};

export const getDefaultAgentSlice = async (
  params: LoadEffectiveUserSettingsParams,
): Promise<unknown> => {
  if (!isPolicyEnabled() && params.legacySettings) {
    return params.legacySettings.defaultAgent;
  }
  const { settings } = await loadEffectiveUserSettings(params);
  return settings.defaultAgent;
};

export const getSystemAgentSlice = async (
  params: LoadEffectiveUserSettingsParams,
): Promise<unknown> => {
  if (!isPolicyEnabled() && params.legacySettings) {
    return params.legacySettings.systemAgent;
  }
  const { settings } = await loadEffectiveUserSettings(params);
  return settings.systemAgent;
};

export const getToolSlice = async (params: LoadEffectiveUserSettingsParams): Promise<unknown> => {
  if (!isPolicyEnabled() && params.legacySettings) {
    return params.legacySettings.tool;
  }
  const { settings } = await loadEffectiveUserSettings(params);
  return settings.tool;
};
