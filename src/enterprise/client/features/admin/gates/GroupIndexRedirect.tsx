'use client';

import { Empty, Text } from '@lobehub/ui';
import { memo, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useDisabledModules } from '@/enterprise/client/hooks/useModuleEnabled';
import {
  ADMIN_NAV_ITEMS,
  type AdminNavItem,
  hasAllPermissions,
  isAdminNavItemModuleDisabled,
} from '@/enterprise/client/nav/adminNavMeta';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

/**
 * Group index route (e.g. `/admin/ai`, `/admin/audit`): the parent path is not a real
 * workspace, so redirect to the first child the current principal can open. Every nav group
 * uses this so no group parent ever renders a dead-end surface.
 */
const GroupIndexRedirect = memo<{ groupId: string }>(({ groupId }) => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { permissions } = useAdminAccess();
  const disabledModules = useDisabledModules();

  const firstChild = useMemo(() => {
    const group = ADMIN_NAV_ITEMS.find((item) => item.id === groupId);
    const children = group?.children ?? [];
    // A group index must never land on a page the deployment switched off — that would show
    // "module not enabled" for a link the admin never chose.
    const reachable = (child: AdminNavItem) =>
      !child.hideFromNav &&
      !isAdminNavItemModuleDisabled(child, disabledModules) &&
      hasAllPermissions(permissions, child.requiredPermissions);
    // A group may pin its index destination (legacy deep link) instead of the menu's first
    // entry; if that child is hidden or not permitted, fall back to the first reachable one.
    const pinned = group?.indexRedirectTo
      ? children.find((child) => child.id === group.indexRedirectTo)
      : undefined;
    if (pinned && reachable(pinned)) return pinned;
    return children.find(reachable);
  }, [disabledModules, groupId, permissions]);

  useEffect(() => {
    if (firstChild) navigate(firstChild.path, { replace: true });
  }, [firstChild, navigate]);

  if (firstChild) {
    return (
      <Text role="status" type="secondary">
        {t('groupRedirect.redirecting')}
      </Text>
    );
  }

  return <Empty description={t('groupRedirect.noAccess')} style={{ paddingBlock: 64 }} />;
});

GroupIndexRedirect.displayName = 'GroupIndexRedirect';

export default GroupIndexRedirect;
