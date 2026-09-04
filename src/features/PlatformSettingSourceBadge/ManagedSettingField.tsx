'use client';

import { memo, type ReactNode, useMemo } from 'react';

import ManagedMetaHeader from './ManagedMetaHeader';
import { type PlatformSettingMetaState } from './usePlatformSettingMeta';

export type ManagedSettingFieldRenderArgs = {
  disabled: boolean;
  hidden: boolean;
  locked: boolean;
};

const isMetaDisabled = (meta: PlatformSettingMetaState) =>
  meta.locked || meta.resetting || meta.status === 'loading' || meta.status === 'error';

/**
 * Wraps a real settings control with platform source/lock/hidden/reset behavior.
 * Flag OFF: children render fully unmanaged (no network, no lock).
 */
export const ManagedSettingFieldContent = memo<{
  children: (args: ManagedSettingFieldRenderArgs) => ReactNode;
  meta: PlatformSettingMetaState;
}>(({ meta, children }) => {
  if (meta.hidden) return null;

  const showBadge = meta.enabled && meta.status === 'ready';

  return (
    <div>
      <ManagedMetaHeader meta={meta} showBadge={showBadge} />
      {children({
        disabled: isMetaDisabled(meta),
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

/**
 * Collapse the leaves a single control atomically edits into one meta.
 *
 * One control must show exactly **one** header: nesting a `ManagedSettingFieldContent`
 * per leaf used to stack an identical 「组织默认」 badge per leaf (model + provider ⇒ two),
 * which is what users saw above the history-compression picker. The aggregation is
 * fail-closed (locked/loading/error on ANY leaf disables the control) and `reset`
 * fans out to every leaf that can be reset, so the merged affordance still does the
 * whole job of the leaves it replaces.
 */
export const mergePlatformSettingMetas = (
  metas: readonly PlatformSettingMetaState[],
): PlatformSettingMetaState => {
  const [first] = metas;
  const resettable = metas.filter((meta) => meta.canReset);

  const status: PlatformSettingMetaState['status'] = metas.some((m) => m.status === 'loading')
    ? 'loading'
    : metas.some((m) => m.status === 'error')
      ? 'error'
      : metas.some((m) => m.status === 'ready')
        ? 'ready'
        : 'disabled';

  // Badge precedence mirrors severity: a locked leaf governs the whole control, and a
  // personal override anywhere is worth surfacing (it is the only resettable state).
  const mode: PlatformSettingMetaState['mode'] = metas.some((m) => m.mode === 'locked')
    ? 'locked'
    : metas.some((m) => m.mode === 'user')
      ? 'user'
      : metas.find((m) => m.mode !== undefined)?.mode;

  const source: PlatformSettingMetaState['source'] = metas.some((m) => m.source === 'user')
    ? 'user'
    : metas.find((m) => m.source !== undefined)?.source;

  return {
    canReset: resettable.length > 0,
    effectiveValue: first?.effectiveValue,
    enabled: metas.some((m) => m.enabled),
    error: metas.find((m) => m.error !== undefined)?.error,
    hidden: metas.some((m) => m.hidden),
    isLoading: metas.some((m) => m.isLoading),
    locked: metas.some((m) => m.locked),
    meta: first?.meta,
    mode,
    reset: async () => {
      const results = await Promise.all(resettable.map((m) => m.reset()));
      return results.length > 0 && results.every(Boolean);
    },
    resetError: metas.find((m) => m.resetError)?.resetError ?? null,
    resetting: metas.some((m) => m.resetting),
    retry: async () => {
      const results = await Promise.all(metas.map((m) => m.retry()));
      return results.find((result) => result !== undefined);
    },
    source,
    status,
  };
};

/** A single real control may atomically edit more than one registered leaf (model + provider). */
export const ManagedCompositeSettingFieldContent = memo<ManagedCompositeSettingFieldContentProps>(
  ({ children, metas }) => {
    const merged = useMemo(() => mergePlatformSettingMetas(metas), [metas]);

    if (metas.length === 0) {
      return children({ disabled: false, hidden: false, locked: false });
    }

    if (merged.hidden) return null;

    const disabled = metas.some(isMetaDisabled);

    return (
      <div>
        <ManagedMetaHeader meta={merged} showBadge={merged.enabled && merged.status === 'ready'} />
        {children({ disabled, hidden: false, locked: disabled })}
      </div>
    );
  },
);

ManagedCompositeSettingFieldContent.displayName = 'ManagedCompositeSettingFieldContent';
