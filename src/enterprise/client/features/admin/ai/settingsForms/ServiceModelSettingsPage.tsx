'use client';

import { Alert, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { AdminProviderSettingsStoreProvider } from '@/enterprise/client/features/admin/ai/providerSettings/AdminProviderSettingsStore';
import AdminAiRuntimeLoadAlert from '@/enterprise/client/features/admin/ai/shared/AdminAiRuntimeLoadAlert';
import AdminPageTemplate from '@/enterprise/client/features/admin/primitives/AdminPageTemplate';
import { ModelAssignmentsFormView } from '@/features/ServiceModel';
import { ImageFormView, OpenAIFormView } from '@/features/SettingsForms';
import { useSaveState } from '@/hooks/useSaveState';
import { useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';
import { featureFlagsSelectors, useServerConfigStore } from '@/store/serverConfig';

import DirtyDraftAlert from './DirtyDraftAlert';
import { usePlatformSettingsDefaults } from './usePlatformSettingsDefaults';

const styles = createStaticStyles(({ css }) => ({
  sections: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  note: css`
    margin-block-end: 8px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

/** Prefetch platform AI catalog into the admin aiInfra store for ModelSelect. */
const AdminAiInfraPrefetch = memo(() => {
  const useFetchAiProviderList = useAiInfraStore((s) => s.useFetchAiProviderList);
  const useFetchRuntime = useAiInfraStore((s) => s.useFetchAiProviderRuntimeState);
  useFetchAiProviderList({ enabled: true });
  const { error: runtimeError, mutate: mutateRuntime } = useFetchRuntime(true);
  const retryRuntime = useCallback(() => mutateRuntime(), [mutateRuntime]);

  if (!runtimeError) return null;
  return <AdminAiRuntimeLoadAlert error={runtimeError} onRetry={retryRuntime} />;
});

const ServiceModelSettingsBody = memo(() => {
  const { t } = useTranslation('admin');
  const { enableSTT, showAiImage } = useServerConfigStore(featureFlagsSelectors);
  const modelSaveState = useSaveState();
  const ttsSaveState = useSaveState();
  const imageSaveState = useSaveState();
  const {
    canWrite,
    clearDirtyDraftBlocked,
    defaultAgent,
    dirtyDraftBlocked,
    error,
    image,
    isInit,
    mappedError,
    mutate,
    systemAgent,
    tts,
    updateDefaultAgentModel,
    updateImage,
    updateSystemAgent,
    updateTts,
  } = usePlatformSettingsDefaults();

  const disabledReason = useMemo(() => {
    if (!canWrite) return t('aiServiceModel.noWritePermission');
    return undefined;
  }, [canWrite, t]);

  return (
    <div className={styles.sections}>
      <Text className={styles.note}>{t('aiServiceModel.autoPublishNote')}</Text>
      {dirtyDraftBlocked && <DirtyDraftAlert onDismiss={clearDirtyDraftBlocked} />}
      {mappedError && (
        <Alert
          showIcon
          closable={false}
          message={t(mappedError.i18nKey as never, { defaultValue: mappedError.code })}
          type="error"
        />
      )}
      <ModelAssignmentsFormView
        canManage={canWrite}
        defaultAgent={defaultAgent}
        disabledReason={disabledReason}
        initError={error}
        isInit={isInit}
        saveState={modelSaveState}
        systemAgentSettings={systemAgent}
        onRetryInit={() => void mutate()}
        onUpdateDefaultAgent={updateDefaultAgentModel}
        onUpdateSystemAgent={updateSystemAgent}
      />
      {enableSTT && (
        <OpenAIFormView
          canManage={canWrite}
          disabledReason={disabledReason}
          isInit={isInit}
          saveState={ttsSaveState}
          value={tts}
          onChange={updateTts}
        />
      )}
      {showAiImage && (
        <ImageFormView
          canManage={canWrite}
          disabledReason={disabledReason}
          isInit={isInit}
          saveState={imageSaveState}
          value={image}
          onChange={updateImage}
        />
      )}
    </div>
  );
});

/**
 * Admin platform-default service model page (parity with user settings/service-model).
 * Model dropdowns use the published platform AI catalog via AdminProviderSettingsStoreProvider.
 */
const ServiceModelSettingsPage = memo(() => {
  const { t } = useTranslation('admin');

  return (
    <AdminPageTemplate
      description={t('aiServiceModel.page.desc')}
      title={t('aiServiceModel.page.title')}
    >
      <AdminProviderSettingsStoreProvider>
        <AdminAiInfraPrefetch />
        <ServiceModelSettingsBody />
      </AdminProviderSettingsStoreProvider>
    </AdminPageTemplate>
  );
});

ServiceModelSettingsPage.displayName = 'ServiceModelSettingsPage';

export default ServiceModelSettingsPage;
