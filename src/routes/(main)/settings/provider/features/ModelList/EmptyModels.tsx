import { Button, Center, Flexbox, Icon, Tooltip } from '@lobehub/ui';
import { App } from 'antd';
import { createStaticStyles } from 'antd-style';
import { BrainIcon, LucideRefreshCcwDot, PlusIcon } from 'lucide-react';
import { memo, use, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePermission } from '@/hooks/usePermission';
import { useAiInfraStoreApi, useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';

import { createCreateNewModelModal } from './CreateNewModelModal';
import { resolveFetchFailureMessage } from './providerFailureCopy';
import { ProviderSettingsContext } from './ProviderSettingsContext';
import { useManagedAiModels } from './useManagedAiModels';
import { useSyncUpstreamModels } from './useSyncUpstreamModels';

const styles = createStaticStyles(({ css, cssVar }) => ({
  circle: css`
    width: 80px;
    height: 80px;
    border-radius: 50%;
    background: ${cssVar.colorFillSecondary};
  `,
  container: css`
    width: 100%;
    border: 1px dashed ${cssVar.colorBorder};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
  `,
  description: css`
    max-width: 280px;

    font-size: ${cssVar.fontSize};
    color: ${cssVar.colorTextDescription};
    text-align: center;
    text-wrap: balance;
  `,
  iconWrapper: css`
    position: relative;
    width: 64px;
    height: 64px;
  `,
  sparklesIcon: css`
    font-size: 40px;
    color: ${cssVar.colorText};
  `,
  title: css`
    font-size: ${cssVar.fontSizeLG};
    font-weight: 500;
  `,
}));

const EmptyState = memo<{ provider: string }>(({ provider }) => {
  const aiInfraStoreApi = useAiInfraStoreApi();
  const { t } = useTranslation('modelProvider');
  /** The connectivity checker's vocabulary, shared so both surfaces name a failure alike. */
  const { t: tSetting } = useTranslation('setting');
  const { message } = App.useApp();
  const { allowed: canManageProvider, reason } = usePermission('manage_provider_key');
  const aiModelsManaged = useManagedAiModels();
  const canMutateModels = canManageProvider && !aiModelsManaged;

  const [fetchRemoteModelList, supportsUpstreamSync] = useAiInfraStore((s) => [
    s.fetchRemoteModelList,
    s.supportsUpstreamSync,
  ]);

  const [fetchRemoteModelsLoading, setFetchRemoteModelsLoading] = useState(false);
  const { showDeployName } = use(ProviderSettingsContext);
  const sync = useSyncUpstreamModels(provider);

  return (
    <Center className={styles.container} gap={24} paddingBlock={40}>
      <Center className={styles.circle}>
        <Icon className={styles.sparklesIcon} icon={BrainIcon} />
      </Center>
      <Flexbox align={'center'} gap={8}>
        <div className={styles.title}>{t('providerModels.list.empty.title')}</div>
        <div className={styles.description}>{t('providerModels.list.empty.desc')}</div>
      </Flexbox>

      <Flexbox horizontal gap={8}>
        {!aiModelsManaged && (
          <Tooltip title={canManageProvider ? '' : reason}>
            <Button
              disabled={!canMutateModels}
              icon={PlusIcon}
              onClick={() => {
                if (!canMutateModels) return;
                createCreateNewModelModal({
                  existingModelIds: aiInfraStoreApi
                    .getState()
                    .aiProviderModelList.map((model) => model.id),
                  showDeployName,
                  store: aiInfraStoreApi,
                });
              }}
            >
              {t('providerModels.list.addNew')}
            </Button>
          </Tooltip>
        )}
        {/*
         * An empty list is where discovery matters most, and the panel that administers a shared
         * platform account cannot use the BYOK fetch below at all — it reads the signed-in
         * operator's own vault. Where upstream sync is available it *is* the primary action, so it
         * replaces the fetch button rather than crowding a third one beside it; on a member's own
         * provider the two are the same call and one button is the honest count.
         */}
        {!aiModelsManaged &&
          (supportsUpstreamSync ? (
            <Tooltip title={sync.disabledReason ?? ''}>
              <Button
                disabled={sync.disabled}
                icon={<Icon icon={LucideRefreshCcwDot} />}
                loading={sync.isSyncing}
                type={'primary'}
                onClick={sync.syncUpstream}
              >
                {sync.isSyncing
                  ? t('providerModels.list.syncUpstream.syncing')
                  : t('providerModels.list.syncUpstream.action')}
              </Button>
            </Tooltip>
          ) : (
            <Tooltip title={canManageProvider ? '' : reason}>
              <Button
                disabled={!canMutateModels}
                icon={<Icon icon={LucideRefreshCcwDot} />}
                loading={fetchRemoteModelsLoading}
                type={'primary'}
                onClick={async () => {
                  if (!canMutateModels) return;
                  setFetchRemoteModelsLoading(true);
                  try {
                    await fetchRemoteModelList(provider);
                  } catch (error) {
                    console.error(error);

                    message.error(
                      t('providerModels.list.fetcher.error', {
                        message: resolveFetchFailureMessage(error, t, tSetting),
                      }),
                    );
                  } finally {
                    setFetchRemoteModelsLoading(false);
                  }
                }}
              >
                {fetchRemoteModelsLoading
                  ? t('providerModels.list.fetcher.fetching')
                  : t('providerModels.list.fetcher.fetch')}
              </Button>
            </Tooltip>
          ))}
      </Flexbox>
    </Center>
  );
});

export default EmptyState;
