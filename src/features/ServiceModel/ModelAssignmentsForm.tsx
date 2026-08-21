'use client';

import type { EffortControlKey } from '@lobechat/model-runtime';
import { EFFORT_CONTROL_KEYS } from '@lobechat/model-runtime';
import isEqual from 'fast-deep-equal';
import { memo } from 'react';

import { usePlatformSettingMeta } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { usePermission } from '@/hooks/usePermission';
import { useSaveState } from '@/hooks/useSaveState';
import { useUserStore } from '@/store/user';
import { settingsSelectors } from '@/store/user/selectors';
import type { UserServiceModelConfigKey } from '@/types/user/settings';

import ModelAssignmentsFormView, { type SystemAgentPolicyMetas } from './ModelAssignmentsFormView';

/**
 * One path literal per EffortControlKey. Must be written as complete strings —
 * `controlWiring.test.ts` greps this file for each registry path (`toContain`),
 * so template strings like `` `defaultAgent.config.chatConfig.${key}` `` do not count.
 */
export const DEFAULT_AGENT_CHAT_CONFIG_EFFORT_PATHS = [
  'defaultAgent.config.chatConfig.codexMaxReasoningEffort',
  'defaultAgent.config.chatConfig.deepseekV4ReasoningEffort',
  'defaultAgent.config.chatConfig.effort',
  'defaultAgent.config.chatConfig.glm5_2ReasoningEffort',
  'defaultAgent.config.chatConfig.gpt5ReasoningEffort',
  'defaultAgent.config.chatConfig.gpt5_1ReasoningEffort',
  'defaultAgent.config.chatConfig.gpt5_2ProReasoningEffort',
  'defaultAgent.config.chatConfig.gpt5_2ReasoningEffort',
  'defaultAgent.config.chatConfig.gpt5_6ReasoningEffort',
  'defaultAgent.config.chatConfig.chatgptWebThinkingEffort',
  'defaultAgent.config.chatConfig.chatgptWebProThinkingEffort',
  'defaultAgent.config.chatConfig.grok4_20ReasoningEffort',
  'defaultAgent.config.chatConfig.grok4_3ReasoningEffort',
  'defaultAgent.config.chatConfig.grok4_5ReasoningEffort',
  'defaultAgent.config.chatConfig.hy3ReasoningEffort',
  'defaultAgent.config.chatConfig.kimiK3ReasoningEffort',
  'defaultAgent.config.chatConfig.opus47Effort',
  'defaultAgent.config.chatConfig.reasoningEffort',
  'defaultAgent.config.chatConfig.ring2_6ReasoningEffort',
  'defaultAgent.config.chatConfig.step3_5ReasoningEffort',
  'defaultAgent.config.chatConfig.thinkingLevel',
  'defaultAgent.config.chatConfig.thinkingLevel2',
  'defaultAgent.config.chatConfig.thinkingLevel3',
  'defaultAgent.config.chatConfig.thinkingLevel4',
  'defaultAgent.config.chatConfig.thinking',
] as const;

/**
 * Fixed-length hook sequence (rules-of-hooks). Only the selected model's key is
 * applied to the effort picker — inactive family leaves must not gate the row.
 */
const useDefaultAgentChatConfigEffortMetas = () =>
  [
    usePlatformSettingMeta('defaultAgent.config.chatConfig.codexMaxReasoningEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.deepseekV4ReasoningEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.effort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.glm5_2ReasoningEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.gpt5ReasoningEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.gpt5_1ReasoningEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.gpt5_2ProReasoningEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.gpt5_2ReasoningEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.gpt5_6ReasoningEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.chatgptWebThinkingEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.chatgptWebProThinkingEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.grok4_20ReasoningEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.grok4_3ReasoningEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.grok4_5ReasoningEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.hy3ReasoningEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.kimiK3ReasoningEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.opus47Effort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.reasoningEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.ring2_6ReasoningEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.step3_5ReasoningEffort'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.thinkingLevel'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.thinkingLevel2'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.thinkingLevel3'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.thinkingLevel4'),
    usePlatformSettingMeta('defaultAgent.config.chatConfig.thinking'),
  ] as const;

/**
 * `reasoningEffort` is absent for `userMemoryEmbedding` on purpose: embedding models expose
 * no thinking budget, so that row renders no effort picker and registering the leaf would
 * declare a control surface that does not exist.
 */
export const SYSTEM_AGENT_POLICY_PATHS = {
  agentMeta: ['model', 'provider', 'reasoningEffort'],
  followUpAction: ['model', 'provider', 'reasoningEffort', 'enabled'],
  generationTopic: ['model', 'provider', 'reasoningEffort'],
  historyCompress: ['model', 'provider', 'reasoningEffort'],
  inputCompletion: ['model', 'provider', 'reasoningEffort', 'enabled'],
  memoryAnalysisAgentConfig: ['model', 'provider', 'reasoningEffort', 'contextLimit'],
  promptRewrite: ['model', 'provider', 'reasoningEffort', 'enabled'],
  topic: ['model', 'provider', 'reasoningEffort'],
  translation: ['model', 'provider', 'reasoningEffort'],
  userMemoryEmbedding: ['model', 'provider', 'contextLimit'],
  userMemoryPersonaWriter: ['model', 'provider', 'reasoningEffort', 'contextLimit'],
} as const satisfies Partial<
  Record<
    UserServiceModelConfigKey,
    readonly ('contextLimit' | 'enabled' | 'model' | 'provider' | 'reasoningEffort')[]
  >
>;

/**
 * User-settings wrapper: binds the pure form to the user store and platform meta.
 * Behaviour is unchanged for ordinary users.
 */
const ModelAssignmentsForm = memo(() => {
  const { allowed: canManageServiceModel, reason } = usePermission('manage_settings');
  const [defaultAgent, systemAgentSettings] = useUserStore(
    (s) => [settingsSelectors.defaultAgent(s), settingsSelectors.currentSystemAgent(s)],
    isEqual,
  );
  const [
    updateDefaultAgent,
    updateSystemAgent,
    isUserStateInit,
    isUserStateInitError,
    refreshUserState,
  ] = useUserStore((s) => [
    s.updateDefaultAgent,
    s.updateSystemAgent,
    s.isUserStateInit,
    s.isUserStateInitError,
    s.refreshUserState,
  ]);
  const saveState = useSaveState();
  const defaultAgentModelMeta = usePlatformSettingMeta('defaultAgent.config.model');
  const defaultAgentProviderMeta = usePlatformSettingMeta('defaultAgent.config.provider');
  const defaultAgentEffortMetaList = useDefaultAgentChatConfigEffortMetas();
  const defaultAgentMetas = [defaultAgentModelMeta, defaultAgentProviderMeta] as const;
  const defaultAgentEffortMetas = Object.fromEntries(
    EFFORT_CONTROL_KEYS.map((key, index) => [key, defaultAgentEffortMetaList[index]]),
  ) as Partial<Record<EffortControlKey, (typeof defaultAgentEffortMetaList)[number]>>;
  const systemAgentMetas: Partial<Record<UserServiceModelConfigKey, SystemAgentPolicyMetas>> = {
    agentMeta: {
      modelProvider: [
        usePlatformSettingMeta('systemAgent.agentMeta.model'),
        usePlatformSettingMeta('systemAgent.agentMeta.provider'),
        usePlatformSettingMeta('systemAgent.agentMeta.reasoningEffort'),
      ],
    },
    followUpAction: {
      enabled: usePlatformSettingMeta('systemAgent.followUpAction.enabled'),
      modelProvider: [
        usePlatformSettingMeta('systemAgent.followUpAction.model'),
        usePlatformSettingMeta('systemAgent.followUpAction.provider'),
        usePlatformSettingMeta('systemAgent.followUpAction.reasoningEffort'),
      ],
    },
    generationTopic: {
      modelProvider: [
        usePlatformSettingMeta('systemAgent.generationTopic.model'),
        usePlatformSettingMeta('systemAgent.generationTopic.provider'),
        usePlatformSettingMeta('systemAgent.generationTopic.reasoningEffort'),
      ],
    },
    historyCompress: {
      modelProvider: [
        usePlatformSettingMeta('systemAgent.historyCompress.model'),
        usePlatformSettingMeta('systemAgent.historyCompress.provider'),
        usePlatformSettingMeta('systemAgent.historyCompress.reasoningEffort'),
      ],
    },
    inputCompletion: {
      enabled: usePlatformSettingMeta('systemAgent.inputCompletion.enabled'),
      modelProvider: [
        usePlatformSettingMeta('systemAgent.inputCompletion.model'),
        usePlatformSettingMeta('systemAgent.inputCompletion.provider'),
        usePlatformSettingMeta('systemAgent.inputCompletion.reasoningEffort'),
      ],
    },
    memoryAnalysisAgentConfig: {
      contextLimit: usePlatformSettingMeta('systemAgent.memoryAnalysisAgentConfig.contextLimit'),
      modelProvider: [
        usePlatformSettingMeta('systemAgent.memoryAnalysisAgentConfig.model'),
        usePlatformSettingMeta('systemAgent.memoryAnalysisAgentConfig.provider'),
        usePlatformSettingMeta('systemAgent.memoryAnalysisAgentConfig.reasoningEffort'),
      ],
    },
    promptRewrite: {
      enabled: usePlatformSettingMeta('systemAgent.promptRewrite.enabled'),
      modelProvider: [
        usePlatformSettingMeta('systemAgent.promptRewrite.model'),
        usePlatformSettingMeta('systemAgent.promptRewrite.provider'),
        usePlatformSettingMeta('systemAgent.promptRewrite.reasoningEffort'),
      ],
    },
    topic: {
      modelProvider: [
        usePlatformSettingMeta('systemAgent.topic.model'),
        usePlatformSettingMeta('systemAgent.topic.provider'),
        usePlatformSettingMeta('systemAgent.topic.reasoningEffort'),
      ],
    },
    translation: {
      modelProvider: [
        usePlatformSettingMeta('systemAgent.translation.model'),
        usePlatformSettingMeta('systemAgent.translation.provider'),
        usePlatformSettingMeta('systemAgent.translation.reasoningEffort'),
      ],
    },
    userMemoryEmbedding: {
      contextLimit: usePlatformSettingMeta('systemAgent.userMemoryEmbedding.contextLimit'),
      modelProvider: [
        usePlatformSettingMeta('systemAgent.userMemoryEmbedding.model'),
        usePlatformSettingMeta('systemAgent.userMemoryEmbedding.provider'),
      ],
    },
    userMemoryPersonaWriter: {
      contextLimit: usePlatformSettingMeta('systemAgent.userMemoryPersonaWriter.contextLimit'),
      modelProvider: [
        usePlatformSettingMeta('systemAgent.userMemoryPersonaWriter.model'),
        usePlatformSettingMeta('systemAgent.userMemoryPersonaWriter.provider'),
        usePlatformSettingMeta('systemAgent.userMemoryPersonaWriter.reasoningEffort'),
      ],
    },
  };

  return (
    <ModelAssignmentsFormView
      canManage={canManageServiceModel}
      defaultAgent={defaultAgent}
      defaultAgentEffortMetas={defaultAgentEffortMetas}
      defaultAgentMetas={defaultAgentMetas}
      disabledReason={reason}
      initError={isUserStateInitError as Error | undefined}
      isInit={isUserStateInit}
      saveState={saveState}
      systemAgentMetas={systemAgentMetas}
      systemAgentSettings={systemAgentSettings}
      onRetryInit={() => refreshUserState()}
      onUpdateSystemAgent={(key, value) => updateSystemAgent(key, value)}
      onUpdateDefaultAgent={({ model, provider }) =>
        updateDefaultAgent({ config: { model, provider } })
      }
      // User settings still merge onto chatConfig. A clear is not representable here
      // (merge drops `undefined`), so the wrapper no-ops `level === undefined`.
      onUpdateDefaultAgentEffort={({ configKey, level }) => {
        if (level === undefined) return;
        return updateDefaultAgent({ config: { chatConfig: { [configKey]: level } } });
      }}
    />
  );
});

ModelAssignmentsForm.displayName = 'ModelAssignmentsForm';

export default ModelAssignmentsForm;
