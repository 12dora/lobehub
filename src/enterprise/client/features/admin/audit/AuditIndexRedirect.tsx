'use client';

import { Empty, Text } from '@lobehub/ui';
import { memo, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { ADMIN_NAV_ITEMS, hasAllPermissions } from '@/enterprise/client/nav/adminNavMeta';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

/**
 * `/admin/audit` group index: redirect to the first child the principal can open.
 * Mirrors the AI group pattern (parent path is not a real workspace).
 */
const AuditIndexRedirect = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { permissions } = useAdminAccess();

  const firstChild = useMemo(() => {
    const group = ADMIN_NAV_ITEMS.find((item) => item.id === 'audit');
    const children = group?.children ?? [];
    return children.find(
      (child) => !child.hideFromNav && hasAllPermissions(permissions, child.requiredPermissions),
    );
  }, [permissions]);

  useEffect(() => {
    if (firstChild) {
      navigate(firstChild.path, { replace: true });
    }
  }, [firstChild, navigate]);

  if (firstChild) {
    return (
      <Text role="status" type="secondary">
        {t('audit.redirecting')}
      </Text>
    );
  }

  return <Empty description={t('audit.noPermission')} style={{ paddingBlock: 64 }} />;
});

AuditIndexRedirect.displayName = 'AuditIndexRedirect';

export default AuditIndexRedirect;
