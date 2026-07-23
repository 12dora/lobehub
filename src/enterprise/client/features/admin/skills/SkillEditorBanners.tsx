'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { SkillRebaseConflict } from './controller';
import type { SkillDraftPersistenceStatus } from './localDraftStorage';

export interface SkillEditorBannersProps {
  actionError: string | null;
  actionLoading: string | null;
  conflict: boolean;
  onDiscardLocal: () => void;
  onRebase: () => void | Promise<void>;
  onResolveRebaseConflict: (
    field: SkillRebaseConflict['field'],
    choice: 'local' | 'latest',
  ) => void;
  onRetryRefresh: () => void;
  persistenceStatus: SkillDraftPersistenceStatus;
  rebaseConflicts: SkillRebaseConflict[];
  refreshFailed: boolean;
}

/**
 * Conflict / persistence / action-error banner stack for the skill identity editor.
 * Order is intentional: action error → CAS conflict → field-level rebase → persistence.
 */
const SkillEditorBanners = memo<SkillEditorBannersProps>(
  ({
    actionError,
    actionLoading,
    conflict,
    onDiscardLocal,
    onRebase,
    onResolveRebaseConflict,
    onRetryRefresh,
    persistenceStatus,
    rebaseConflicts,
    refreshFailed,
  }) => {
    const { t } = useTranslation('admin');

    return (
      <>
        {actionError ? (
          <Alert
            showIcon
            message={actionError}
            type="error"
            extra={
              refreshFailed ? (
                <Button loading={actionLoading === 'refresh'} onClick={onRetryRefresh}>
                  {t('skillCatalog.actions.retry')}
                </Button>
              ) : null
            }
          />
        ) : null}
        {conflict ? (
          <Alert
            showIcon
            description={t('skillCatalog.conflict.desc')}
            message={t('skillCatalog.conflict.title')}
            type="warning"
            extra={
              <Flexbox horizontal gap={8}>
                <Button onClick={() => void onRebase()}>{t('skillCatalog.conflict.rebase')}</Button>
                <Button onClick={onDiscardLocal}>{t('skillCatalog.conflict.discard')}</Button>
              </Flexbox>
            }
          />
        ) : null}
        {rebaseConflicts.length ? (
          <Alert
            showIcon
            message={t('skillCatalog.conflict.fields')}
            type="warning"
            description={
              <Flexbox gap={8}>
                {rebaseConflicts.map((item) => (
                  <Flexbox gap={4} key={item.field}>
                    <Text strong>{item.field}</Text>
                    <Text type="secondary">
                      {t('skillCatalog.conflict.values', {
                        latest: String(item.latest),
                        local: String(item.local),
                      })}
                    </Text>
                    <Flexbox horizontal gap={8}>
                      <Button onClick={() => onResolveRebaseConflict(item.field, 'local')}>
                        {t('skillCatalog.conflict.keepLocal')}
                      </Button>
                      <Button onClick={() => onResolveRebaseConflict(item.field, 'latest')}>
                        {t('skillCatalog.conflict.useLatest')}
                      </Button>
                    </Flexbox>
                  </Flexbox>
                ))}
              </Flexbox>
            }
          />
        ) : null}
        {persistenceStatus !== 'saved' ? (
          <Alert
            showIcon
            message={t(`skillCatalog.persistence.${persistenceStatus}` as never)}
            type="warning"
          />
        ) : null}
      </>
    );
  },
);

SkillEditorBanners.displayName = 'SkillEditorBanners';

export default SkillEditorBanners;
