'use client';

import { Empty, Text } from '@lobehub/ui';
import { memo, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { ADMIN_NAV_ITEMS, hasAllPermissions } from '@/enterprise/client/nav/adminNavMeta';
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

  const firstChild = useMemo(() => {
    const group = ADMIN_NAV_ITEMS.find((item) => item.id === groupId);
    const children = group?.children ?? [];
    return children.find(
      (child) => !child.hideFromNav && hasAllPermissions(permissions, child.requiredPermissions),
    );
  }, [groupId, permissions]);

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
