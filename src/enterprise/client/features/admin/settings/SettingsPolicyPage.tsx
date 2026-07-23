'use client';

import { Alert, Flexbox, Input, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { useSettingsPolicyEditor } from './hooks/useSettingsPolicyEditor';
import SettingsPolicyChangePreview from './SettingsPolicyChangePreview';
import SettingsPolicyConflictBanner from './SettingsPolicyConflictBanner';
import SettingsPolicyGroupGrid from './SettingsPolicyGroupGrid';

const styles = createStaticStyles(({ css }) => ({
  error: css`
    color: ${cssVar.colorError};
  `,
  footer: css`
    position: sticky;
    z-index: 2;
    inset-block-end: 0;

    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    margin-block-start: 8px;
    padding-block: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgLayout};
  `,
  scroll: css`
    overflow: auto;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 16px;

    min-height: 0;
  `,
  status: css`
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

const SettingsPolicyPage = memo<{ embedded?: boolean }>(({ embedded }) => {
  const { t } = useTranslation('admin');
  const editor = useSettingsPolicyEditor();
  const {
    activeBaseRevision,
    activeDraftToken,
    canPublish,
    canUpdate,
    conflictState,
    data,
    dirty,
    error,
    filteredEntries,
    getPolicy,
    handleDiscardConflict,
    handlePublish,
    handleRebase,
    handleResetDefaults,
    handleSaveDraft,
    handleValidate,
    impact,
    isLoading,
    mutate,
    ownPublishedOverrideCount,
    policyEnabled,
    preview,
    primary,
    refreshConflictServer,
    refreshError,
    registryByPath,
    retryRefresh,
    revisionConflict,
    saveError,
    saveState,
    search,
    setSearch,
    updatePolicy,
    validatedBaseRevision,
    validatedDraftToken,
    validationMsg,
  } = editor;

  // U1: policy flag off → disabled surface, zero getDraft
  if (!policyEnabled) {
    return (
      <AdminPageTemplate
        description={t('settingsPolicy.desc')}
        hideTitle={embedded}
        title={t('settingsPolicy.title')}
      >
        <Text type="secondary">{t('settingsPolicy.featureDisabled')}</Text>
      </AdminPageTemplate>
    );
  }

  // Error before empty
  if (error) {
    const mapped = mapEnterpriseError(error);
    return (
      <AdminPageTemplate
        description={t('settingsPolicy.desc')}
        hideTitle={embedded}
        title={t('settingsPolicy.title')}
        actions={
          <Button
            onClick={() => {
              void mutate();
            }}
          >
            {t('primitives.dataTable.retry')}
          </Button>
        }
      >
        <Text className={styles.error}>
          {mapped ? t(mapped.i18nKey as never, { defaultValue: mapped.code }) : String(error)}
        </Text>
      </AdminPageTemplate>
    );
  }

  if (isLoading || !data) {
    return (
      <AdminPageTemplate
        description={t('settingsPolicy.desc')}
        hideTitle={embedded}
        title={t('settingsPolicy.title')}
      >
        <Text type="secondary">{t('primitives.dataTable.loading')}</Text>
      </AdminPageTemplate>
    );
  }

  // Exactly one primary action — sticky footer only (U5)
  const primaryButton =
    primary === 'save' || primary === 'retry' ? (
      <Button
        disabled={!canUpdate}
        loading={saveState === 'saving'}
        type="primary"
        onClick={() => void handleSaveDraft()}
      >
        {primary === 'retry' ? t('settingsPolicy.retrySave') : t('settingsPolicy.saveDraft')}
      </Button>
    ) : primary === 'validate' ? (
      <Button
        disabled={!canUpdate && !canPublish}
        type="primary"
        onClick={() => void handleValidate()}
      >
        {t('settingsPolicy.validate')}
      </Button>
    ) : primary === 'publish' ? (
      <Button
        type="primary"
        disabled={
          !canPublish ||
          validatedDraftToken !== activeDraftToken ||
          validatedBaseRevision !== activeBaseRevision ||
          activeBaseRevision !== data.baseRevision ||
          activeDraftToken !== data.draftToken
        }
        onClick={handlePublish}
      >
        {t('settingsPolicy.publish')}
      </Button>
    ) : null;

  return (
    <AdminPageTemplate
      hideTitle={embedded}
      title={t('settingsPolicy.title')}
      actions={
        <Flexbox horizontal gap={8}>
          {canPublish && canUpdate ? (
            <Button
              disabled={
                dirty ||
                revisionConflict ||
                activeBaseRevision !== data.baseRevision ||
                activeDraftToken !== data.draftToken ||
                ownPublishedOverrideCount === 0
              }
              onClick={handleResetDefaults}
            >
              {t('settingsPolicy.resetDefaults')}
            </Button>
          ) : null}
        </Flexbox>
      }
      banner={
        <>
          {refreshError ? (
            <Alert
              showIcon
              description={refreshError}
              message={t('settingsPolicy.refresh.committedTitle')}
              type="warning"
              extra={
                <Button onClick={() => void retryRefresh()}>
                  {t('settingsPolicy.refresh.retry')}
                </Button>
              }
            />
          ) : null}
          {revisionConflict ? (
            <SettingsPolicyConflictBanner
              canUpdate={canUpdate}
              conflictState={conflictState}
              registryByPath={registryByPath}
              onDiscard={handleDiscardConflict}
              onRebase={handleRebase}
              onRefresh={() => void refreshConflictServer()}
            />
          ) : null}
        </>
      }
      description={
        canUpdate
          ? t('settingsPolicy.desc')
          : `${t('settingsPolicy.desc')} ${t('settingsPolicy.readOnlyHint')}`
      }
      toolbar={
        <Input
          allowClear
          placeholder={t('settingsPolicy.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      }
    >
      <div className={styles.scroll}>
        {validationMsg ? <Text type="secondary">{validationMsg}</Text> : null}
        {impact ? (
          <Text type="secondary">
            {t('settingsPolicy.impactSummary', {
              paths: impact.pathsWithOverrides,
              rows: impact.totalOverrideRows,
            })}
          </Text>
        ) : null}
        <SettingsPolicyChangePreview preview={preview} registryByPath={registryByPath} />
        <SettingsPolicyGroupGrid
          canUpdate={canUpdate}
          entries={filteredEntries}
          getPolicy={getPolicy}
          publishedPolicies={data.publishedPolicies}
          updatePolicy={updatePolicy}
        />
      </div>

      <div className={styles.footer}>
        <span className={styles.status}>
          {saveState === 'saving' && t('settingsPolicy.saveState.saving')}
          {saveState === 'saved' && t('settingsPolicy.saveState.saved')}
          {saveState === 'failed' && (saveError || t('settingsPolicy.saveState.failed'))}
          {saveState === 'idle' &&
            (dirty ? t('settingsPolicy.saveState.dirty') : t('settingsPolicy.saveState.idle'))}
          {' · '}
          {t('settingsPolicy.revision', { revision: activeBaseRevision })}
        </span>
        <Flexbox horizontal gap={8}>
          {primaryButton}
        </Flexbox>
      </div>
    </AdminPageTemplate>
  );
});

SettingsPolicyPage.displayName = 'SettingsPolicyPage';

export default SettingsPolicyPage;
