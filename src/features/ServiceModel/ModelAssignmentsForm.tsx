'use client';

import isEqual from 'fast-deep-equal';
import { memo } from 'react';

import {
  type PlatformSettingMetaState,
  usePlatformSettingMeta,
} from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { usePermission } from '@/hooks/usePermission';
import { useSaveState } from '@/hooks/useSaveState';
import { useUserStore } from '@/store/user';
import { settingsSelectors } from '@/store/user/selectors';
import type { UserServiceModelConfigKey } from '@/types/user/settings';

import ModelAssignmentsFormView from './ModelAssignmentsFormView';

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
  const topicModelMeta = usePlatformSettingMeta('systemAgent.topic.model');
  const topicProviderMeta = usePlatformSettingMeta('systemAgent.topic.provider');
  const translationModelMeta = usePlatformSettingMeta('systemAgent.translation.model');
  const historyCompressModelMeta = usePlatformSettingMeta('systemAgent.historyCompress.model');

  const defaultAgentMetas = [defaultAgentModelMeta, defaultAgentProviderMeta] as const;
  const systemAgentMetas: Partial<
    Record<UserServiceModelConfigKey, readonly PlatformSettingMetaState[]>
  > = {
    historyCompress: [historyCompressModelMeta],
    topic: [topicModelMeta, topicProviderMeta],
    translation: [translationModelMeta],
  };

  return (
    <ModelAssignmentsFormView
      canManage={canManageServiceModel}
      defaultAgent={defaultAgent}
      defaultAgentMetas={defaultAgentMetas}
      disabledReason={reason}
      initError={isUserStateInitError}
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
