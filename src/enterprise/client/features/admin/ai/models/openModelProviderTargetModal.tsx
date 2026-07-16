'use client';

import { Flexbox, Input, Text } from '@lobehub/ui';
import { Button, createModal, useModalContext } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import i18next from 'i18next';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import NeuralNetworkLoading from '@/components/NeuralNetworkLoading';
import { adminAiCatalogService } from '@/enterprise/client/services/adminAiCatalog';

import { useModelProviderTargetPicker } from '../hooks/useModelProviderTargetPicker';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
  footer: css`
    display: flex;
    gap: 8px;
    justify-content: space-between;
  `,
  list: css`
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;

    max-height: 320px;
  `,
  state: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: center;
    justify-content: center;

    min-height: 160px;

    text-align: center;
  `,
  target: css`
    justify-content: flex-start;

    width: 100%;
    height: auto;
    padding-block: 10px;

    text-align: start;

    &[data-selected='true'] {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: -2px;
    }
  `,
  targetIdentity: css`
    align-items: flex-start;
    min-width: 0;
  `,
}));

export interface ModelProviderTargetContentProps {
  onSubmit: (providerId: string) => Promise<void>;
}

const ModelProviderTargetContent = memo<ModelProviderTargetContentProps>(({ onSubmit }) => {
  const { t } = useTranslation('admin');
  const { close } = useModalContext();
  const picker = useModelProviderTargetPicker({
    loadTargets: adminAiCatalogService.listModelCreateTargets,
    onSubmit,
  });
  const isTargetLoading = picker.isLoading || picker.isSearchPending;

  return (
    <div className={styles.body}>
      <Text type="secondary">{t('aiCatalog.models.providerTarget.desc')}</Text>
      <Input
        allowClear
        aria-label={t('aiCatalog.models.providerTarget.search')}
        disabled={picker.isSubmitting}
        placeholder={t('aiCatalog.models.providerTarget.search')}
        value={picker.query}
        onChange={(event) => picker.setQuery(event.target.value)}
      />

      {isTargetLoading ? (
        <div className={styles.state}>
          <NeuralNetworkLoading size={28} />
          <Text type="secondary">{t('aiCatalog.models.providerTarget.loading')}</Text>
        </div>
      ) : picker.loadFailed ? (
        <div className={styles.state} role="alert">
          <Text type="secondary">{t('aiCatalog.models.providerTarget.loadError')}</Text>
          <Button onClick={picker.retryLoad}>{t('aiCatalog.models.providerTarget.retry')}</Button>
        </div>
      ) : picker.items.length === 0 ? (
        <div className={styles.state}>
          <Text type="secondary">
            {picker.query.trim()
              ? t('aiCatalog.models.providerTarget.noResults')
              : t('aiCatalog.models.providerTarget.empty')}
          </Text>
        </div>
      ) : (
        <div
          aria-label={t('aiCatalog.models.providerTarget.list')}
          className={styles.list}
          role="group"
        >
          {picker.items.map((item) => {
            const selected = picker.selectedProviderId === item.id;
            return (
              <Button
                aria-pressed={selected}
                className={styles.target}
                data-selected={selected}
                disabled={picker.isSubmitting}
                key={item.id}
                type="default"
                onClick={() => picker.selectProvider(item.id)}
              >
                <Flexbox className={styles.targetIdentity} gap={2}>
                  <Text ellipsis strong>
                    {item.displayName}
                  </Text>
                  <Text ellipsis type="secondary">
                    {item.providerKey}
                  </Text>
                </Flexbox>
              </Button>
            );
          })}
        </div>
      )}

      {picker.submitFailed ? (
        <Text className={styles.error} role="alert">
          {t('aiCatalog.models.providerTarget.submitError')}
        </Text>
      ) : null}
      <div className={styles.footer}>
        <Flexbox horizontal gap={8}>
          <Button
            disabled={!picker.canGoPrevious || isTargetLoading || picker.isSubmitting}
            onClick={picker.goToPreviousPage}
          >
            {t('aiCatalog.models.providerTarget.previous')}
          </Button>
          <Button
            disabled={!picker.canGoNext || isTargetLoading || picker.isSubmitting}
            onClick={picker.goToNextPage}
          >
            {t('aiCatalog.models.providerTarget.next')}
          </Button>
          <Text type="secondary">
            {t('aiCatalog.models.providerTarget.page', { page: picker.page })}
          </Text>
        </Flexbox>
        <Flexbox horizontal gap={8}>
          <Button disabled={picker.isSubmitting} onClick={close}>
            {t('users.modals.cancel')}
          </Button>
          <Button
            disabled={!picker.selectedProviderId || isTargetLoading || picker.loadFailed}
            loading={picker.isSubmitting}
            type="primary"
            onClick={() => {
              void picker.submit().then((succeeded) => {
                if (succeeded) close();
              });
            }}
          >
            {t('aiCatalog.models.actions.create')}
          </Button>
        </Flexbox>
      </div>
    </div>
  );
});

ModelProviderTargetContent.displayName = 'AdminAiModelProviderTargetContent';

export const openModelProviderTargetModal = (props: ModelProviderTargetContentProps) =>
  createModal({
    content: <ModelProviderTargetContent {...props} />,
    footer: null,
    maskClosable: false,
    title: i18next.t('aiCatalog.models.providerTarget.title', { ns: 'admin' }),
    width: 'min(92vw, 520px)',
  });
