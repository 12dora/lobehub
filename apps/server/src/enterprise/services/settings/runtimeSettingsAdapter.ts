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

import type { UserInterventionConfig } from '@lobechat/types';

import { UserModel } from '@/database/models/user';
import type { LobeChatDatabase } from '@/database/type';
import type { EffectiveSettingsResult } from '@/types/platform/settings';

import { getEnterpriseFeatureFlags } from '../../featureFlags';
import { EffectiveSettingsService } from './effectiveSettingsService';
import { settingsRegistry } from './registry';

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

type RawUserSettings = Awaited<ReturnType<UserModel['getUserSettings']>>;

/**
 * Per-invocation slot so `execAgent` can share one `getUserSettings()` between
 * memory + timezone without a process-wide TTL (settings writes stay visible
 * on the next message).
 */
export interface UserSettingsReadMemo {
  inflight?: Promise<RawUserSettings>;
  value?: RawUserSettings;
}

/**
 * Raw `user_settings` row. Pass a {@link UserSettingsReadMemo} to dedupe
 * within one `execAgent` call; omit it to always read the DB.
 */
export const getRawUserSettings = async (params: {
  db: LobeChatDatabase;
  memo?: UserSettingsReadMemo;
  userId: string;
}): Promise<RawUserSettings> => {
  if (params.memo?.value !== undefined) return params.memo.value;
  if (params.memo?.inflight) return params.memo.inflight;

  const inflight = new UserModel(params.db, params.userId).getUserSettings();
  if (params.memo) params.memo.inflight = inflight;

  try {
    const value = await inflight;
    if (params.memo) params.memo.value = value;
    return value;
  } finally {
    if (params.memo?.inflight === inflight) params.memo.inflight = undefined;
  }
};

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
 * Effective defaultAgent for AgentService merge.
 *
 * - Flag OFF: identical to UserModel.getUserSettingsDefaultAgentConfig()
 * - Flag ON personal: platform + personal override/legacy
 * - Flag ON workspace: **platform layer only** (builtin + published policies) —
 *   no personal overrides/legacy leak into workspace agents (B1-R2)
 */
export const getEffectiveDefaultAgentConfig = async (params: {
  db: LobeChatDatabase;
  userId: string;
  /**
   * `workspace` applies platform defaults/locks without personal settings.
   * `personal` (default) includes personal overrides.
   */
  scope?: 'personal' | 'workspace';
}): Promise<unknown> => {
  const scope = params.scope ?? 'personal';

  if (!isPolicyEnabled()) {
    if (scope === 'workspace') return null;
    const userModel = new UserModel(params.db, params.userId);
    return userModel.getUserSettingsDefaultAgentConfig();
  }

  if (scope === 'workspace') {
    const service = new EffectiveSettingsService(params.db);
    const platformOnly = await service.getPlatformLayerEffectiveSettings();
    return platformOnly.effectiveSettings.defaultAgent ?? null;
  }

  const userModel = new UserModel(params.db, params.userId);
  const row = await userModel.getUserSettings();
  const legacy = {
    defaultAgent: row?.defaultAgent,
    general: row?.general,
    systemAgent: row?.systemAgent,
    tool: row?.tool,
    memory: row?.memory,
  };
  const { settings } = await loadEffectiveUserSettings({
    db: params.db,
    legacySettings: legacy as Record<string, unknown>,
    userId: params.userId,
  });
  return settings.defaultAgent ?? null;
};

/**
 * Effective memory settings slice (aiAgent exec path).
 * Flag OFF: raw user_settings.memory (parent parity).
 */
export const getEffectiveMemorySettings = async (params: {
  db: LobeChatDatabase;
  memo?: UserSettingsReadMemo;
  scope?: 'personal' | 'workspace';
  userId: string;
}): Promise<{ enabled?: boolean; effort?: string } | undefined> => {
  const scope = params.scope ?? 'personal';
  if (!isPolicyEnabled()) {
    const settings = await getRawUserSettings(params);
    return settings?.memory as { enabled?: boolean; effort?: string } | undefined;
  }

  if (scope === 'workspace') {
    const service = new EffectiveSettingsService(params.db);
    const platformOnly = await service.getPlatformLayerEffectiveSettings();
    return platformOnly.effectiveSettings.memory as
      { enabled?: boolean; effort?: string } | undefined;
  }

  const row = await getRawUserSettings(params);
  const { settings } = await loadEffectiveUserSettings({
    db: params.db,
    legacySettings: { memory: row?.memory } as Record<string, unknown>,
    userId: params.userId,
  });
  return settings.memory as { enabled?: boolean; effort?: string } | undefined;
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

export type EffectiveUserInterventionConfig = UserInterventionConfig;

/**
 * Resolve tool.humanIntervention for execAgent (R3-B1).
 *
 * Flag OFF: return caller config unchanged (legacy / headless default).
 * Flag ON: force approvalMode from effective settings so request body cannot
 * override locked/default/effective platform policy. allowList may still come
 * from the caller when mode is allow-list and not platform-locked-only.
 */
export const resolveEffectiveUserInterventionConfig = async (params: {
  callerConfig?: UserInterventionConfig | null;
  db: LobeChatDatabase;
  scope?: 'personal' | 'workspace';
  userId: string;
}): Promise<EffectiveUserInterventionConfig | undefined> => {
  const caller = params.callerConfig ?? undefined;

  if (!isPolicyEnabled()) {
    // Exact legacy: pass through (including undefined → caller default)
    return caller;
  }

  const service = new EffectiveSettingsService(params.db);
  let effectiveApproval: string | undefined;

  if (params.scope === 'workspace') {
    const platform = await service.getPlatformLayerEffectiveSettings();
    effectiveApproval = platform.effectiveValues['tool.humanIntervention.approvalMode'] as
      string | undefined;
  } else {
    const userModel = new UserModel(params.db, params.userId);
    const row = await userModel.getUserSettings();
    const { settings } = await loadEffectiveUserSettings({
      db: params.db,
      legacySettings: { tool: row?.tool } as Record<string, unknown>,
      userId: params.userId,
    });
    const tool = settings.tool as
      { humanIntervention?: { allowList?: string[]; approvalMode?: string } } | undefined;
    effectiveApproval = tool?.humanIntervention?.approvalMode;
  }

  const approvalMode = settingsRegistry.validateValue(
    'tool.humanIntervention.approvalMode',
    effectiveApproval ?? caller?.approvalMode ?? 'headless',
  );
  if (!approvalMode.ok) {
    throw new Error(`Invalid effective intervention policy: ${approvalMode.message}`);
  }

  return {
    allowList: caller?.allowList,
    approvalMode: approvalMode.value as EffectiveUserInterventionConfig['approvalMode'],
  };
};
