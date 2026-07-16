'use client';

import { Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import PlatformSettingSourceBadge from './index';
import { usePlatformSettingMeta } from './usePlatformSettingMeta';

export type ManagedSettingFieldRenderArgs = {
  disabled: boolean;
  hidden: boolean;
  locked: boolean;
};

/**
 * Wraps a real settings control with platform source/lock/hidden/reset behavior.
 * Flag OFF: children render fully unmanaged (no network, no lock).
 */
const ManagedSettingField = memo<{
  children: (args: ManagedSettingFieldRenderArgs) => ReactNode;
  path: string;
}>(({ path, children }) => {
  const { t } = useTranslation('setting');
  const meta = usePlatformSettingMeta(path);

  if (meta.status === 'loading') {
    return <Text type="secondary">{t('platformSource.loadingMeta', { defaultValue: '…' })}</Text>;
  }

  if (meta.status === 'error') {
    return (
      <Button size="small" type="text" onClick={() => meta.retry()}>
        {t('platformSource.retryMeta', { defaultValue: 'Retry loading settings policy' })}
      </Button>
    );
  }

  if (meta.hidden) return null;

  const showBadge = meta.enabled && meta.status === 'ready';

  return (
    <div>
      {showBadge ? (
        <PlatformSettingSourceBadge
          locked={meta.locked}
          mode={meta.mode}
          source={meta.source}
          onReset={
            meta.mode === 'default' && meta.source === 'user'
              ? () => {
                  void meta.reset().catch(() => {
                    /* resetError on meta */
                  });
                }
              : undefined
          }
        />
      ) : null}
      {meta.resetError ? (
        <Text type="danger">
          {meta.resetError}{' '}
          <Button size="small" type="text" onClick={() => void meta.reset().catch(() => {})}>
            {t('platformSource.retryReset', { defaultValue: 'Retry' })}
          </Button>
        </Text>
      ) : null}
      {children({
        disabled: meta.locked || meta.resetting,
        hidden: meta.hidden,
        locked: meta.locked,
      })}
    </div>
  );
});

ManagedSettingField.displayName = 'ManagedSettingField';

export default ManagedSettingField;
