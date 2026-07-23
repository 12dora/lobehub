'use client';

/**
 * Form-compatible managed control: forwards value/onChange from Ant Form.Item
 * to the inner control while applying platform lock/source/reset (R3-U3).
 */

import { Tooltip } from '@lobehub/ui';
import { cloneElement, isValidElement, memo, type ReactElement, type ReactNode } from 'react';

import ManagedMetaHeader from './ManagedMetaHeader';
import { type PlatformSettingMetaState } from './usePlatformSettingMeta';

type ManagedFormControlProps = {
  children: ReactElement;
  /** Explain a non-policy disabled state such as missing permission. */
  disabledReason?: ReactNode;
  /** Extra disabled (permission etc.) */
  extraDisabled?: boolean;
  path: string;
};

/**
 * Place as the **sole** named Form.Item child so value/onChange bind to the inner control.
 * Structure: Form.Item name=x → <ManagedFormControl path=...><Switch/></ManagedFormControl>
 */
type ManagedFormControlContentProps = Omit<ManagedFormControlProps, 'path'> & {
  meta: PlatformSettingMetaState;
};

export const ManagedFormControlContent = memo<ManagedFormControlContentProps>(
  ({ children, disabledReason, extraDisabled, meta, ...formInjected }) => {
    const childProps = children.props as { disabled?: boolean };

    // Flag OFF / disabled capability: exact unmanaged — forward form props only
    if (meta.status === 'disabled') {
      if (!isValidElement(children)) return children as ReactNode;

      const unmanagedControl = cloneElement(children, {
        ...childProps,
        ...formInjected,
        disabled: Boolean(extraDisabled) || childProps.disabled,
      } as never);

      return disabledReason && extraDisabled ? (
        <Tooltip title={disabledReason}>{unmanagedControl}</Tooltip>
      ) : (
        unmanagedControl
      );
    }

    if (meta.hidden) return null;

    const locked =
      meta.locked ||
      meta.resetting ||
      meta.status === 'loading' ||
      meta.status === 'error' ||
      Boolean(extraDisabled);

    return (
      <div>
        <ManagedMetaHeader meta={meta} showBadge={meta.status === 'ready'} />
        {isValidElement(children) ? (
          disabledReason && locked ? (
            <Tooltip title={disabledReason}>
              {cloneElement(children, {
                ...childProps,
                ...formInjected,
                disabled: locked || childProps.disabled,
              } as never)}
            </Tooltip>
          ) : (
            cloneElement(children, {
              ...childProps,
              ...formInjected,
              disabled: locked || childProps.disabled,
            } as never)
          )
        ) : (
          children
        )}
      </div>
    );
  },
);

ManagedFormControlContent.displayName = 'ManagedFormControlContent';
