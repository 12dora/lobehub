'use client';

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
  const defaultAgentMetas = [defaultAgentModelMeta, defaultAgentProviderMeta] as const;
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
      // The default assistant has no registry leaf for effort — it rides the agent's own
      // chatConfig under the key the model's effort control declares, exactly like the
      // in-chat controls write it. `level` is always concrete: chatConfig fields are strict
      // level unions, so the picker offers no clear here.
      onUpdateDefaultAgentEffort={({ configKey, level }) =>
        updateDefaultAgent({ config: { chatConfig: { [configKey]: level } } })
      }
    />
  );
});

ModelAssignmentsForm.displayName = 'ModelAssignmentsForm';

export default ModelAssignmentsForm;
