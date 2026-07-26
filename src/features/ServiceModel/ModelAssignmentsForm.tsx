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

export const SYSTEM_AGENT_POLICY_PATHS = {
  agentMeta: ['model', 'provider'],
  followUpAction: ['model', 'provider', 'enabled'],
  generationTopic: ['model', 'provider'],
  historyCompress: ['model', 'provider'],
  inputCompletion: ['model', 'provider', 'enabled'],
  memoryAnalysisAgentConfig: ['model', 'provider', 'contextLimit'],
  promptRewrite: ['model', 'provider', 'enabled'],
  topic: ['model', 'provider'],
  translation: ['model', 'provider'],
  userMemoryEmbedding: ['model', 'provider', 'contextLimit'],
  userMemoryPersonaWriter: ['model', 'provider', 'contextLimit'],
} as const satisfies Partial<
  Record<UserServiceModelConfigKey, readonly ('contextLimit' | 'enabled' | 'model' | 'provider')[]>
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
      ],
    },
    followUpAction: {
      enabled: usePlatformSettingMeta('systemAgent.followUpAction.enabled'),
      modelProvider: [
        usePlatformSettingMeta('systemAgent.followUpAction.model'),
        usePlatformSettingMeta('systemAgent.followUpAction.provider'),
      ],
    },
    generationTopic: {
      modelProvider: [
        usePlatformSettingMeta('systemAgent.generationTopic.model'),
        usePlatformSettingMeta('systemAgent.generationTopic.provider'),
      ],
    },
    historyCompress: {
      modelProvider: [
        usePlatformSettingMeta('systemAgent.historyCompress.model'),
        usePlatformSettingMeta('systemAgent.historyCompress.provider'),
      ],
    },
    inputCompletion: {
      enabled: usePlatformSettingMeta('systemAgent.inputCompletion.enabled'),
      modelProvider: [
        usePlatformSettingMeta('systemAgent.inputCompletion.model'),
        usePlatformSettingMeta('systemAgent.inputCompletion.provider'),
      ],
    },
    memoryAnalysisAgentConfig: {
      contextLimit: usePlatformSettingMeta('systemAgent.memoryAnalysisAgentConfig.contextLimit'),
      modelProvider: [
        usePlatformSettingMeta('systemAgent.memoryAnalysisAgentConfig.model'),
        usePlatformSettingMeta('systemAgent.memoryAnalysisAgentConfig.provider'),
      ],
    },
    promptRewrite: {
      enabled: usePlatformSettingMeta('systemAgent.promptRewrite.enabled'),
      modelProvider: [
        usePlatformSettingMeta('systemAgent.promptRewrite.model'),
        usePlatformSettingMeta('systemAgent.promptRewrite.provider'),
      ],
    },
    topic: {
      modelProvider: [
        usePlatformSettingMeta('systemAgent.topic.model'),
        usePlatformSettingMeta('systemAgent.topic.provider'),
      ],
    },
    translation: {
      modelProvider: [
        usePlatformSettingMeta('systemAgent.translation.model'),
        usePlatformSettingMeta('systemAgent.translation.provider'),
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
    />
  );
});

ModelAssignmentsForm.displayName = 'ModelAssignmentsForm';

export default ModelAssignmentsForm;
