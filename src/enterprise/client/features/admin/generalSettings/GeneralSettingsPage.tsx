'use client';

import { Alert, Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import { MAX_WIDTH } from '@/const/layoutTokens';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import GeneralSettingsForm from './GeneralSettingsForm';
import { useGeneralSettingsEditor } from './useGeneralSettingsEditor';

const styles = createStaticStyles(({ css }) => ({
  footer: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: flex-end;
  `,
}));

const GeneralSettingsPage = memo<{ embedded?: boolean }>(({ embedded }) => {
  const { t } = useTranslation('admin');
  const {
    acceptRecovery,
    baseRevision,
    canUpdate,
    data,
    discardAndRefresh,
    discardRecovery,
    dirty,
    draft,
    error,
    handleSave,
    isLoading,
    mutate,
    patch,
    recoveryOffer,
    revisionConflict,
    saving,
    serverStale,
  } = useGeneralSettingsEditor({ embedded });

  const renderLoaded = () => {
    if (!draft) return <Loading debugId="AdminGeneralSettings > Hydrate" />;
    const disabled = !canUpdate || serverStale || revisionConflict;

    return (
      <AdminPageTemplate
        description={t('generalSettings.desc')}
        hideTitle={embedded}
        maxWidth={MAX_WIDTH}
        title={t('generalSettings.title')}
      >
        {disabled && !serverStale && !revisionConflict ? (
          <Alert showIcon message={t('generalSettings.readOnly')} type="info" />
        ) : null}
        {recoveryOffer && !serverStale && !revisionConflict ? (
          <Alert
            showIcon
            description={t('generalSettings.recovery.description')}
            message={t('generalSettings.recovery.title')}
            type="info"
            extra={
              <Flexbox horizontal gap={8}>
                <Button type="primary" onClick={acceptRecovery}>
                  {t('generalSettings.recovery.restore')}
                </Button>
                <Button onClick={discardRecovery}>{t('generalSettings.recovery.discard')}</Button>
              </Flexbox>
            }
          />
        ) : null}
        {serverStale || revisionConflict ? (
          <Alert
            showIcon
            type="warning"
            description={
              revisionConflict
                ? t('generalSettings.conflict.description')
                : t('generalSettings.stale.description')
            }
            extra={
              <Button onClick={discardAndRefresh}>{t('generalSettings.stale.refresh')}</Button>
            }
            message={
              revisionConflict
                ? t('generalSettings.conflict.title')
                : t('generalSettings.stale.title')
            }
          />
        ) : null}

        <GeneralSettingsForm disabled={disabled} draft={draft} onPatch={patch} />

        {canUpdate ? (
          <div className={styles.footer}>
            <Button
              disabled={!dirty || serverStale || revisionConflict || baseRevision === null}
              loading={saving}
              type="primary"
              onClick={() => void handleSave()}
            >
              {t('generalSettings.save')}
            </Button>
          </div>
        ) : null}
      </AdminPageTemplate>
    );
  };

  return (
    <AsyncBoundary
      data={data}
      error={error}
      errorVariant="page"
      isLoading={isLoading}
      loading={<Loading debugId="AdminGeneralSettings" />}
      onRetry={() => void mutate()}
    >
      {data ? renderLoaded() : null}
    </AsyncBoundary>
  );
});

GeneralSettingsPage.displayName = 'GeneralSettingsPage';

export default GeneralSettingsPage;
