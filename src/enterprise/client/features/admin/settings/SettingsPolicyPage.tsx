'use client';

import { Alert, Input, Skeleton, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useReducedMotion } from 'motion/react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { useSettingsPolicyEditor } from './hooks/useSettingsPolicyEditor';
import SettingsPolicyChangePreview from './SettingsPolicyChangePreview';
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
  toolbarActions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;

    margin-inline-start: auto;
  `,
  /** Search on the left (capped), page-level actions pinned to the right. */
  toolbarRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    width: 100%;
  `,
  toolbarSearch: css`
    flex: 1 1 240px;
    min-width: 200px;
    max-width: 320px;
  `,
}));

const SettingsPolicyPage = memo<{ embedded?: boolean }>(({ embedded }) => {
  const { t } = useTranslation('admin');
  const reduceMotion = useReducedMotion();
  const editor = useSettingsPolicyEditor({ embedded });
  const {
    canSave,
    conflictState,
    data,
    dismissConflict,
    error,
    filteredEntries,
    getPolicy,
    handleResetDefaults,
    handleSave,
    hasEffectiveChanges,
    isLoading,
    mutate,
    ownPublishedOverrideCount,
    policyEnabled,
    preview,
    refreshError,
    registryByPath,
    retryConflictReload,
    retryRefresh,
    saveError,
    saveState,
    search,
    setSearch,
    updatePolicy,
  } = editor;

  // U1: policy flag off → disabled surface, zero getDraft
  if (!policyEnabled) {
    return (
      <AdminPageTemplate hideTitle={embedded} title={t('settingsPolicy.title')}>
        <Text type="secondary">{t('settingsPolicy.featureDisabled')}</Text>
      </AdminPageTemplate>
    );
  }

  // Error before empty
  if (error) {
    const mapped = mapEnterpriseError(error);
    return (
      <AdminPageTemplate
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
          {mapped?.i18nKey
            ? t(mapped.i18nKey as never, {
                defaultValue: t('settingsPolicy.loadFailed', {
                  defaultValue: 'Could not load settings policy. Retry to try again.',
                }),
              })
            : t('settingsPolicy.loadFailed', {
                defaultValue: 'Could not load settings policy. Retry to try again.',
              })}
        </Text>
      </AdminPageTemplate>
    );
  }

  if (isLoading || !data) {
    return (
      <AdminPageTemplate hideTitle={embedded} title={t('settingsPolicy.title')}>
        <div aria-label={t('primitives.dataTable.loading')} role="status">
          <Skeleton title active={!reduceMotion} paragraph={{ rows: 8 }} />
        </div>
      </AdminPageTemplate>
    );
  }

  return (
    <AdminPageTemplate
      hideTitle={embedded}
      title={t('settingsPolicy.title')}
      banner={
        <>
          {conflictState === 'reloaded' ? (
            <Alert
              closable
              showIcon
              message={t('settingsPolicy.conflict.reloaded')}
              type="warning"
              onClose={dismissConflict}
            />
          ) : null}
          {conflictState === 'reloadFailed' ? (
            <Alert
              showIcon
              description={t('settingsPolicy.conflict.reloadFailedDesc')}
              message={t('settingsPolicy.conflict.reloadFailed')}
              type="warning"
              extra={
                <Button onClick={() => void retryConflictReload()}>
                  {t('settingsPolicy.conflict.retryReload')}
                </Button>
              }
            />
          ) : null}
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
        </>
      }
      notice={
        canSave ? undefined : <Text type="secondary">{t('settingsPolicy.readOnlyHint')}</Text>
      }
      toolbar={
        <div className={styles.toolbarRow}>
          <Input
            allowClear
            className={styles.toolbarSearch}
            placeholder={t('settingsPolicy.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {canSave ? (
            <div className={styles.toolbarActions}>
              <Button
                disabled={
                  hasEffectiveChanges || saveState === 'saving' || ownPublishedOverrideCount === 0
                }
                onClick={handleResetDefaults}
              >
                {t('settingsPolicy.resetDefaults')}
              </Button>
            </div>
          ) : null}
        </div>
      }
    >
      <div className={styles.scroll}>
        <SettingsPolicyChangePreview preview={preview} registryByPath={registryByPath} />
        <SettingsPolicyGroupGrid
          canUpdate={canSave}
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
            (hasEffectiveChanges
              ? t('settingsPolicy.saveState.dirty')
              : t('settingsPolicy.upToDate'))}
        </span>
        {canSave ? (
          <Button
            /* `saved` covers the window where the commit landed but the published snapshot
               has not been reloaded yet — the preview is stale, not a pending change. */
            disabled={!hasEffectiveChanges || saveState === 'saved'}
            loading={saveState === 'saving'}
            type="primary"
            onClick={() => void handleSave()}
          >
            {t('settingsPolicy.save')}
          </Button>
        ) : null}
      </div>
    </AdminPageTemplate>
  );
});

SettingsPolicyPage.displayName = 'SettingsPolicyPage';

export default SettingsPolicyPage;
