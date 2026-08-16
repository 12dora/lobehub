'use client';

import { Alert, Flexbox, Skeleton, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import ManageGuard from '../ManageGuard';
import { moderationStyles as styles } from '../styles';
import AutoBanSection from './sections/AutoBanSection';
import BasicSection from './sections/BasicSection';
import CacheSection from './sections/CacheSection';
import CategoriesSection from './sections/CategoriesSection';
import ClassifierSection from './sections/ClassifierSection';
import KeywordsSection from './sections/KeywordsSection';
import RecordsSection from './sections/RecordsSection';
import ScopeSection from './sections/ScopeSection';
import { useModerationSettingsForm } from './useModerationSettingsForm';

export interface SettingsTabProps {
  canManage: boolean;
  enabled: boolean;
}

/**
 * 设置 tab (design §6.3). Direct save, no drafts: one 保存 button writes the whole config with
 * a revision CAS. A conflict never silently overwrites the other admin — it offers a reload.
 */
const SettingsTab = memo<SettingsTabProps>(({ canManage, enabled }) => {
  const {
    baseRevision,
    classifierMessage,
    clearingCache,
    configDirty,
    conflict,
    data,
    dirty,
    draft,
    error,
    fieldError,
    handleAutoBanToggle,
    handleClearCache,
    handleModeChange,
    handleSave,
    importText,
    isLoading,
    issues,
    keywordsPending,
    mutate,
    patch,
    permissions,
    persistedBaseUrl,
    reload,
    saving,
    setAddedKeys,
    setImportText,
    t,
  } = useModerationSettingsForm({ canManage, enabled });

  if (isLoading && !data) return <Skeleton.Block height={320} width="100%" />;

  if (error && !data) {
    return (
      <Alert
        showIcon
        message={t('contentModeration.settings.loadFailed')}
        type="error"
        action={
          <Button size="small" onClick={() => void mutate()}>
            {t('contentModeration.charts.retry')}
          </Button>
        }
      />
    );
  }

  if (!draft || !data) return null;

  const formDisabled = !canManage || saving;

  return (
    <Flexbox className={styles.stack} gap={16}>
      {conflict ? (
        <Alert
          showIcon
          description={t('contentModeration.settings.conflictDesc')}
          message={t('contentModeration.settings.conflictTitle')}
          type="warning"
          action={
            <Button size="small" onClick={() => void reload()}>
              {t('contentModeration.settings.reload')}
            </Button>
          }
        />
      ) : null}

      {!canManage ? (
        <Alert showIcon message={t('contentModeration.settings.readOnly')} type="info" />
      ) : null}

      <div className={styles.tableToolbar}>
        <Text className={styles.hintText} data-testid="settings-status">
          {keywordsPending
            ? t('contentModeration.settings.keywordsValidating')
            : dirty
              ? t('contentModeration.settings.dirty')
              : t('contentModeration.settings.saved', { revision: baseRevision ?? 0 })}
        </Text>
        <ManageGuard allowed={canManage}>
          <Button
            disabled={!canManage || saving || keywordsPending || !configDirty}
            loading={saving}
            type="primary"
            onClick={() => void handleSave()}
          >
            {t('contentModeration.settings.save')}
          </Button>
        </ManageGuard>
      </div>

      <BasicSection
        catalog={data.catalog}
        config={draft.config}
        disabled={formDisabled}
        onModeChange={handleModeChange}
        onPatch={patch}
      />
      <ScopeSection
        canSearchUsers={permissions.includes(PLATFORM_PERMISSIONS.USER_READ)}
        catalog={data.catalog}
        config={draft.config}
        disabled={formDisabled}
        roles={data.roles}
        onPatch={patch}
      />
      <ClassifierSection
        canManage={canManage}
        catalog={data.catalog}
        disabled={formDisabled}
        draft={draft}
        fieldError={classifierMessage}
        keywordsPending={keywordsPending}
        persistedBaseUrl={persistedBaseUrl}
        onAddedKeysChange={setAddedKeys}
        onPatch={patch}
      />
      <CategoriesSection config={draft.config} disabled={formDisabled} onPatch={patch} />
      <KeywordsSection
        config={draft.config}
        disabled={formDisabled}
        fieldError={fieldError?.field === 'keywords' ? fieldError : null}
        importText={importText}
        onImportTextChange={setImportText}
        onPatch={patch}
      />
      <CacheSection
        canManage={canManage}
        clearing={clearingCache}
        config={draft.config}
        disabled={formDisabled}
        onClearCache={handleClearCache}
        onPatch={patch}
      />
      <AutoBanSection
        config={draft.config}
        disabled={formDisabled}
        onEnableChange={handleAutoBanToggle}
        onPatch={patch}
      />
      <RecordsSection config={draft.config} disabled={formDisabled} onPatch={patch} />

      {issues.length > 0 ? (
        <Alert
          showIcon
          data-testid="moderation-settings-issues"
          message={t(`contentModeration.errors.${issues[0].key}` as never, issues[0].params)}
          type="warning"
        />
      ) : null}
    </Flexbox>
  );
});

SettingsTab.displayName = 'ModerationSettingsTab';

export default SettingsTab;
