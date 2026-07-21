'use client';

import { Alert, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import AdminPageTemplate from '@/enterprise/client/features/admin/primitives/AdminPageTemplate';
import { useSaveState } from '@/hooks/useSaveState';
import MemoryFormView from '@/routes/(main)/settings/memory/features/MemoryFormView';

import DirtyDraftAlert from './DirtyDraftAlert';
import { usePlatformSettingsDefaults } from './usePlatformSettingsDefaults';

const styles = createStaticStyles(({ css }) => ({
  note: css`
    margin-block-end: 8px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

/**
 * Admin platform-default memory settings page (parity with user settings/memory).
 * Does not include the personal "manage memory" entry button.
 */
const MemorySettingsPage = memo(() => {
  const { t } = useTranslation('admin');
  const saveState = useSaveState();
  const {
    canWrite,
    clearDirtyDraftBlocked,
    dirtyDraftBlocked,
    isInit,
    mappedError,
    memory,
    updateMemory,
  } = usePlatformSettingsDefaults();

  const disabledReason = useMemo(() => {
    if (!canWrite) return t('aiMemory.noWritePermission');
    return undefined;
  }, [canWrite, t]);

  return (
    <AdminPageTemplate description={t('aiMemory.page.desc')} title={t('aiMemory.page.title')}>
      <Text className={styles.note}>{t('aiMemory.autoPublishNote')}</Text>
      {dirtyDraftBlocked && <DirtyDraftAlert onDismiss={clearDirtyDraftBlocked} />}
      {mappedError && (
        <Alert
          showIcon
          closable={false}
          message={t(mappedError.i18nKey as never, { defaultValue: mappedError.code })}
          type="error"
        />
      )}
      <MemoryFormView
        canManage={canWrite}
        disabledReason={disabledReason}
        isInit={isInit}
        saveState={saveState}
        value={memory}
        onChange={updateMemory}
      />
    </AdminPageTemplate>
  );
});

MemorySettingsPage.displayName = 'MemorySettingsPage';

export default MemorySettingsPage;
