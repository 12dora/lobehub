'use client';

import { Tooltip } from '@lobehub/ui/base-ui';
import { memo, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

export interface ManageGuardProps {
  /** Whether the current admin holds the permission the control needs. */
  allowed: boolean;
  /** The control itself; it must already be rendered disabled when `allowed` is false. */
  children: ReactElement;
  /** i18n key (admin namespace) naming the missing permission. */
  reasonKey?: 'contentModeration.needManage' | 'contentModeration.needUserBan';
}

/**
 * MANAGE-only controls are never hidden (design §6): a read-only auditor must still see that the
 * action exists and be told why it is unavailable. The disabled control is wrapped in a span so
 * the tooltip still receives pointer events — a disabled <button> emits none of its own.
 */
const ManageGuard = memo<ManageGuardProps>(
  ({ allowed, children, reasonKey = 'contentModeration.needManage' }) => {
    const { t } = useTranslation('admin');
    if (allowed) return children;
    return (
      <Tooltip title={t(reasonKey)}>
        <span data-testid="manage-guard" style={{ display: 'inline-flex' }} tabIndex={0}>
          {children}
        </span>
      </Tooltip>
    );
  },
);

ManageGuard.displayName = 'ModerationManageGuard';

export default ManageGuard;
