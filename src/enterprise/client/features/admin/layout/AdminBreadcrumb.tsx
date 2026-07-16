'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';

import { getAdminBreadcrumbs } from '@/enterprise/client/nav/adminNavMeta';

import { adminShellStyles } from './style';

const AdminBreadcrumb = memo(() => {
  const { t } = useTranslation('admin');
  const location = useLocation();
  const crumbs = getAdminBreadcrumbs(location.pathname);

  return (
    <nav aria-label={t('breadcrumb.aria')} className={adminShellStyles.breadcrumb}>
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <span key={crumb.id}>
            {index > 0 && <span aria-hidden="true"> / </span>}
            {isLast ? (
              <span aria-current="page">{t(crumb.labelKey)}</span>
            ) : (
              <Link to={crumb.path}>{t(crumb.labelKey)}</Link>
            )}
          </span>
        );
      })}
    </nav>
  );
});

AdminBreadcrumb.displayName = 'AdminBreadcrumb';

export default AdminBreadcrumb;
