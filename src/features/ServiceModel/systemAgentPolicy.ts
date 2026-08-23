import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import type { SystemAgentItem, UserServiceModelConfigKey } from '@/types/user/settings';

export interface SystemAgentModelItem {
  contextLimit?: boolean;
  key: UserServiceModelConfigKey;
  modelType?: 'chat' | 'embedding';
}

export interface SystemAgentPolicyMetas {
  contextLimit?: PlatformSettingMetaState;
  enabled?: PlatformSettingMetaState;
  /**
   * Leaves the single model picker cluster writes atomically:
   * `model`, `provider` and (where registered) `reasoningEffort`.
   */
  modelProvider: readonly PlatformSettingMetaState[];
}

export const getSystemAgentPatchMetas = (
  policy: SystemAgentPolicyMetas | undefined,
  value: Partial<SystemAgentItem>,
): PlatformSettingMetaState[] => [
  ...('model' in value || 'provider' in value || 'reasoningEffort' in value
    ? (policy?.modelProvider ?? [])
    : []),
  ...('enabled' in value && policy?.enabled ? [policy.enabled] : []),
  ...('contextLimit' in value && policy?.contextLimit ? [policy.contextLimit] : []),
];

export const isSystemAgentPolicyRowHidden = (policy: SystemAgentPolicyMetas | undefined) =>
  Boolean(
    policy?.modelProvider.some((meta) => meta.hidden) ||
    policy?.enabled?.hidden ||
    policy?.contextLimit?.hidden,
  );

export type LoadingKey = 'defaultAgent' | UserServiceModelConfigKey;
export type SavingGroup = 'assignments' | 'memory' | 'optional';

export const SYSTEM_AGENT_MODEL_ITEMS: SystemAgentModelItem[] = [
  { key: 'topic' },
  { key: 'generationTopic' },
  { key: 'translation' },
  { key: 'historyCompress' },
  { key: 'agentMeta' },
];

export const OPTIONAL_FEATURE_ITEMS: SystemAgentModelItem[] = [
  { key: 'followUpAction' },
  { key: 'inputCompletion' },
  { key: 'promptRewrite' },
];

export const MEMORY_MODEL_ITEMS: SystemAgentModelItem[] = [
  { contextLimit: true, key: 'memoryAnalysisAgentConfig' },
  { contextLimit: true, key: 'userMemoryPersonaWriter' },
  { contextLimit: true, key: 'userMemoryEmbedding', modelType: 'embedding' },
];

/** Each form group owns its own AutoSaveHint, so a write must resolve to its group. */
export const savingGroupOfKey = (key: UserServiceModelConfigKey): SavingGroup => {
  if (MEMORY_MODEL_ITEMS.some((item) => item.key === key)) return 'memory';
  if (OPTIONAL_FEATURE_ITEMS.some((item) => item.key === key)) return 'optional';
  return 'assignments';
};
