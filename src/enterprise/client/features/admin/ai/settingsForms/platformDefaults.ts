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
import type { UserImageConfig, UserMemorySettings } from '@lobechat/types';

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

export const buildDefaultAgentFromPolicies = (policies: PolicyMap): LobeAgentSettings => ({
  ...DEFAULT_AGENT,
  config: {
    ...DEFAULT_AGENT.config,
    model: policyValue(policies, 'defaultAgent.config.model', DEFAULT_AGENT.config.model),
    provider: policyValue(policies, 'defaultAgent.config.provider', DEFAULT_AGENT.config.provider),
  },
});

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

    result[key] = next as UserServiceModelConfig[typeof key];
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

/** Flatten a system-agent partial update into registry path patches. */
export const systemAgentPatch = (
  key: UserServiceModelConfigKey,
  value: Partial<SystemAgentItem>,
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  if (value.model !== undefined) patch[`systemAgent.${key}.model`] = value.model;
  if (value.provider !== undefined) patch[`systemAgent.${key}.provider`] = value.provider;
  if (value.enabled !== undefined) patch[`systemAgent.${key}.enabled`] = value.enabled;
  if (value.contextLimit !== undefined) {
    patch[`systemAgent.${key}.contextLimit`] =
      typeof value.contextLimit === 'number' ? value.contextLimit : null;
  }
  return patch;
};
