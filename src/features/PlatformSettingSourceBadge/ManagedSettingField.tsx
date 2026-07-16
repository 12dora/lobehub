'use client';

import { Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import PlatformSettingSourceBadge from './index';
import { type PlatformSettingMetaState, usePlatformSettingMeta } from './usePlatformSettingMeta';

export type ManagedSettingFieldRenderArgs = {
  disabled: boolean;
  hidden: boolean;
  locked: boolean;
};

/**
 * Wraps a real settings control with platform source/lock/hidden/reset behavior.
 * Flag OFF: children render fully unmanaged (no network, no lock).
 */
export const ManagedSettingFieldContent = memo<{
  children: (args: ManagedSettingFieldRenderArgs) => ReactNode;
  meta: PlatformSettingMetaState;
}>(({ meta, children }) => {
  const { t } = useTranslation('setting');

  if (meta.hidden) return null;

  const showBadge = meta.enabled && meta.status === 'ready';
  const disabled =
    meta.locked || meta.resetting || meta.status === 'loading' || meta.status === 'error';

  return (
    <div>
      {showBadge ? (
        <PlatformSettingSourceBadge
          locked={meta.locked}
          mode={meta.mode}
          resetting={meta.resetting}
          source={meta.source}
          onReset={
            meta.canReset
              ? () => {
                  void meta.reset();
                }
              : undefined
          }
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
      {children({
        disabled,
        hidden: meta.hidden,
        locked: meta.locked,
      })}
    </div>
  );
});

ManagedSettingFieldContent.displayName = 'ManagedSettingFieldContent';

interface ManagedCompositeSettingFieldContentProps {
  children: (args: ManagedSettingFieldRenderArgs) => ReactNode;
  metas: readonly PlatformSettingMetaState[];
}

const ManagedCompositeLayer = memo<
  ManagedCompositeSettingFieldContentProps & { disabled: boolean; index: number }
>(({ children, disabled, index, metas }) => {
  const meta = metas[index];

  if (!meta) {
    return children({ disabled, hidden: false, locked: disabled });
  }

  return (
    <ManagedSettingFieldContent meta={meta}>
      {(state) => (
        <ManagedCompositeLayer
          disabled={disabled || state.disabled}
          index={index + 1}
          metas={metas}
        >
          {children}
        </ManagedCompositeLayer>
      )}
    </ManagedSettingFieldContent>
  );
});

ManagedCompositeLayer.displayName = 'ManagedCompositeLayer';

/** A single real control may atomically edit more than one registered leaf (model + provider). */
export const ManagedCompositeSettingFieldContent = memo<ManagedCompositeSettingFieldContentProps>(
  ({ children, metas }) => {
    if (metas.some((meta) => meta.hidden)) return null;

    return (
      <ManagedCompositeLayer disabled={false} index={0} metas={metas}>
        {children}
      </ManagedCompositeLayer>
    );
  },
);

ManagedCompositeSettingFieldContent.displayName = 'ManagedCompositeSettingFieldContent';

const ManagedSettingField = memo<{
  children: (args: ManagedSettingFieldRenderArgs) => ReactNode;
  path: string;
}>(({ path, children }) => {
  const meta = usePlatformSettingMeta(path);

  return <ManagedSettingFieldContent meta={meta}>{children}</ManagedSettingFieldContent>;
});

ManagedSettingField.displayName = 'ManagedSettingField';

export default ManagedSettingField;
