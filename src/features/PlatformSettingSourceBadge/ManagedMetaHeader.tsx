'use client';

import { Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import PlatformSettingSourceBadge from './index';
import { type PlatformSettingMetaState } from './usePlatformSettingMeta';

/**
 * Shared managed-meta header: source badge + loading / error-retry / reset-error affordances.
 * Extracted from ManagedFormControlContent and ManagedSettingFieldContent, which rendered an
 * identical block. Behavior is preserved because each caller passes its own badge-visibility
 * condition via `showBadge` (form controls show it whenever meta is ready; setting fields also
 * require `meta.enabled`).
 */
const ManagedMetaHeader = memo<{ meta: PlatformSettingMetaState; showBadge: boolean }>(
  ({ meta, showBadge }) => {
    const { t } = useTranslation('setting');
    return (
      <>
        {showBadge ? (
          <PlatformSettingSourceBadge
            locked={meta.locked}
            mode={meta.mode}
            resetting={meta.resetting}
            source={meta.source}
            onReset={meta.canReset ? () => void meta.reset() : undefined}
          />
        ) : null}
        {meta.status === 'loading' ? (
          <Text type="secondary">{t('platformSource.loadingMeta')}</Text>
        ) : null}
        {meta.status === 'error' ? (
          <Button size="small" type="text" onClick={() => void meta.retry()}>
            {t('platformSource.retryMeta')}
          </Button>
        ) : null}
        {meta.resetError ? (
          <Text type="danger">
            {t('platformSource.resetFailed')}{' '}
            <Button
              disabled={meta.resetting}
              size="small"
              type="text"
              onClick={() => void meta.reset()}
            >
              {t('platformSource.retryReset')}
            </Button>
          </Text>
        ) : null}
      </>
    );
  },
);

ManagedMetaHeader.displayName = 'ManagedMetaHeader';

export default ManagedMetaHeader;
