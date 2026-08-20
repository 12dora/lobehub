/**
 * Helpers to map platform settings policies ↔ service-model / memory form values.
 */

import {
  DEFAULT_AGENT,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_SYSTEM_AGENT_CONFIG,
  DEFAULT_TTS_CONFIG,
} from '@lobechat/const';
import { EFFORT_CONTROL_KEYS } from '@lobechat/model-runtime';
import type { LobeAgentChatConfig, UserImageConfig, UserMemorySettings } from '@lobechat/types';

import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';
import type { LobeAgentSettings } from '@/types/session';
import type {
  SystemAgentItem,
  UserServiceModelConfig,
  UserServiceModelConfigKey,
} from '@/types/user/settings';

type PolicyMap = AdminSettingsGetDraftOutput['publishedPolicies'];

const policyValue = <T>(policies: PolicyMap, path: string, fallback: T): T => {
  if (!Object.prototype.hasOwnProperty.call(policies, path)) return fallback;
  return policies[path]?.value as T;
};

const SYSTEM_AGENT_KEYS = Object.keys(DEFAULT_SYSTEM_AGENT_CONFIG) as UserServiceModelConfigKey[];

export const buildDefaultAgentFromPolicies = (policies: PolicyMap): LobeAgentSettings => {
  const chatConfig: LobeAgentChatConfig = { ...DEFAULT_AGENT.config.chatConfig };

  for (const key of EFFORT_CONTROL_KEYS) {
    const path = `defaultAgent.config.chatConfig.${key}`;
    if (!Object.prototype.hasOwnProperty.call(policies, path)) continue;
    const value = policies[path]?.value;
    if (typeof value === 'string') Object.assign(chatConfig, { [key]: value });
  }

  return {
    ...DEFAULT_AGENT,
    config: {
      ...DEFAULT_AGENT.config,
      chatConfig,
      model: policyValue(policies, 'defaultAgent.config.model', DEFAULT_AGENT.config.model),
      provider: policyValue(
        policies,
        'defaultAgent.config.provider',
        DEFAULT_AGENT.config.provider,
      ),
    },
  };
};

export const defaultAgentEffortPath = (configKey: keyof LobeAgentChatConfig) =>
  `defaultAgent.config.chatConfig.${String(configKey)}`;

/** Concrete level → publish that leaf. */
export const defaultAgentEffortPatch = (
  configKey: keyof LobeAgentChatConfig,
  level: string,
): Record<string, unknown> => ({
  [defaultAgentEffortPath(configKey)]: level,
});

/** Explicit applyImmediate deletion of the effort policy row. */
export const defaultAgentEffortRemovePaths = (
  configKey: keyof LobeAgentChatConfig,
): readonly string[] => [defaultAgentEffortPath(configKey)];

export const buildSystemAgentFromPolicies = (policies: PolicyMap): UserServiceModelConfig => {
  const result = { ...DEFAULT_SYSTEM_AGENT_CONFIG } as UserServiceModelConfig;

  for (const key of SYSTEM_AGENT_KEYS) {
    const base = DEFAULT_SYSTEM_AGENT_CONFIG[key];
    const next: SystemAgentItem = {
      ...base,
      model: policyValue(policies, `systemAgent.${key}.model`, base.model),
      provider: policyValue(policies, `systemAgent.${key}.provider`, base.provider),
    };

    if ('enabled' in base || policies[`systemAgent.${key}.enabled`]) {
      next.enabled = policyValue(policies, `systemAgent.${key}.enabled`, base.enabled ?? false);
    }

    // Nullable leaf: a cleared platform default reads back as null and must present as
    // "unset" so the picker falls back to the provider default rather than showing null.
    const effort = policyValue<SystemAgentItem['reasoningEffort']>(
      policies,
      `systemAgent.${key}.reasoningEffort`,
      base.reasoningEffort ?? null,
    );
    if (effort) next.reasoningEffort = effort;
    else delete next.reasoningEffort;

    if (
      key === 'memoryAnalysisAgentConfig' ||
      key === 'userMemoryPersonaWriter' ||
      key === 'userMemoryEmbedding'
    ) {
      const limit = policyValue<number | null | undefined>(
        policies,
        `systemAgent.${key}.contextLimit`,
        base.contextLimit ?? null,
      );
      if (typeof limit === 'number') next.contextLimit = limit;
      else delete next.contextLimit;
    }

    // Union-keyed write: TS cannot narrow the per-key intersection value type here.
    Object.assign(result, { [key]: next });
  }

  return result;
};

export const buildMemoryFromPolicies = (policies: PolicyMap): UserMemorySettings => ({
  enabled: policyValue(policies, 'memory.enabled', DEFAULT_MEMORY_SETTINGS.enabled ?? true),
  effort: policyValue(policies, 'memory.effort', DEFAULT_MEMORY_SETTINGS.effort ?? 'medium'),
});

export const buildTtsFromPolicies = (policies: PolicyMap) => ({
  ...DEFAULT_TTS_CONFIG,
  openAI: {
    ...DEFAULT_TTS_CONFIG.openAI,
    ttsModel: policyValue(policies, 'tts.openAI.ttsModel', DEFAULT_TTS_CONFIG.openAI.ttsModel),
  },
});

export const buildImageFromPolicies = (policies: PolicyMap): UserImageConfig => ({
  ...DEFAULT_IMAGE_CONFIG,
  defaultImageNum: policyValue(
    policies,
    'image.defaultImageNum',
    DEFAULT_IMAGE_CONFIG.defaultImageNum,
  ),
});

/**
 * Flatten a system-agent partial update into registry path patches.
 * Uses `'key' in value` so explicit clears (e.g. contextLimit: undefined) become null writes.
 */
export const systemAgentPatch = (
  key: UserServiceModelConfigKey,
  value: Partial<SystemAgentItem>,
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  if ('model' in value && value.model !== undefined) {
    patch[`systemAgent.${key}.model`] = value.model;
  }
  if ('provider' in value && value.provider !== undefined) {
    patch[`systemAgent.${key}.provider`] = value.provider;
  }
  if ('enabled' in value && value.enabled !== undefined) {
    patch[`systemAgent.${key}.enabled`] = value.enabled;
  }
  // Clear (undefined) → null for the nullable registry schema path.
  if ('reasoningEffort' in value) {
    patch[`systemAgent.${key}.reasoningEffort`] = value.reasoningEffort ?? null;
  }
  // Clear (undefined) → null for the nullable registry schema path.
  if ('contextLimit' in value) {
    patch[`systemAgent.${key}.contextLimit`] =
      typeof value.contextLimit === 'number' ? value.contextLimit : null;
  }
  return patch;
};

/** True when an enterprise error is the applyImmediate dirty-draft rejection. */
export const isUnpublishedSettingsDraftError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;

  const digDetails = (body: unknown): unknown => {
    if (!body || typeof body !== 'object') return undefined;
    return (body as { details?: unknown }).details;
  };

  // Structured enterprise body (tRPC errorData / cause.data)
  const data = (error as { data?: { errorData?: unknown } }).data?.errorData;
  const causeData = (error as { cause?: { data?: unknown } }).cause?.data;
  const candidates = [data, causeData, error];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const code = (candidate as { code?: unknown }).code;
    const details = digDetails(candidate) as { reason?: unknown } | undefined;
    if (
      code === 'PLATFORM_INVALID_INPUT' &&
      details &&
      details.reason === 'unpublished_draft_outside_patch'
    ) {
      return true;
    }
  }

  // Service-layer thrown error (direct tests / non-tRPC)
  if (
    (error as { name?: string }).name === 'SettingsDirtyDraftError' ||
    String((error as { message?: unknown }).message ?? '').includes(
      'Unpublished settings draft differs',
    )
  ) {
    return true;
  }

  return false;
};
