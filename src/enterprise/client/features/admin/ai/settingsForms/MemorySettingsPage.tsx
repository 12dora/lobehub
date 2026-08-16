'use client';

import { Alert, Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MAX_WIDTH } from '@/const/layoutTokens';
import AdminPageTemplate from '@/enterprise/client/features/admin/primitives/AdminPageTemplate';
import { MemoryFormView } from '@/features/SettingsForms';
import { useSaveState } from '@/hooks/useSaveState';

import DirtyDraftAlert from './DirtyDraftAlert';
import { usePlatformSettingsDefaults } from './usePlatformSettingsDefaults';

/**
 * Admin platform-default memory settings page (parity with user settings/memory).
 * Does not include the personal "manage memory" entry button.
 */
const MemorySettingsPage = memo(() => {
  const { t } = useTranslation('admin');
  const saveState = useSaveState();
  const [retrying, setRetrying] = useState(false);
  const {
    canWrite,
    clearDirtyDraftBlocked,
    dirtyDraftBlocked,
    error,
    isInit,
    mappedError,
    memory,
    mutate,
    updateMemory,
  } = usePlatformSettingsDefaults();

  const disabledReason = useMemo(() => {
    if (!canWrite) return t('aiMemory.noWritePermission');
    return undefined;
  }, [canWrite, t]);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    try {
      await mutate();
    } catch {
      // Keep mapped/unmapped error state visible; do not rethrow through the void click handler.
    } finally {
      setRetrying(false);
    }
  }, [mutate]);

  const fetchFailed = Boolean(error) && !isInit;
  const errorMessage = mappedError
    ? t(mappedError.i18nKey as never, { defaultValue: mappedError.code })
    : t('aiMemory.fetchFailed');

  return (
    <AdminPageTemplate
      description={t('aiMemory.page.desc')}
      maxWidth={MAX_WIDTH}
      title={t('aiMemory.page.title')}
    >
      {dirtyDraftBlocked && <DirtyDraftAlert onDismiss={clearDirtyDraftBlocked} />}
      {fetchFailed ? (
        <Alert
          showIcon
          closable={false}
          message={errorMessage}
          type="error"
          action={
            <Button loading={retrying} size="small" onClick={() => void handleRetry()}>
              {t('aiMemory.retry')}
            </Button>
          }
        />
      ) : (
        <Flexbox gap={12}>
          {mappedError && isInit && (
            <Alert
              showIcon
              closable={false}
              message={errorMessage}
              type="error"
              action={
                <Button loading={retrying} size="small" onClick={() => void handleRetry()}>
                  {t('aiMemory.retry')}
                </Button>
              }
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
        </Flexbox>
      )}
    </AdminPageTemplate>
  );
});

MemorySettingsPage.displayName = 'MemorySettingsPage';

export default MemorySettingsPage;
