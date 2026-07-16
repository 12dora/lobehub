'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';

import {
  ADMIN_NAV_ITEMS,
  type AdminNavItem,
  filterAdminNavByPermissions,
} from '@/enterprise/client/nav/adminNavMeta';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import { adminShellStyles } from './style';

const isActivePath = (pathname: string, itemPath: string) => {
  if (itemPath === '/admin') return pathname === '/admin' || pathname === '/admin/';
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`);
};

const NavLink = memo<{ item: AdminNavItem }>(({ item }) => {
  const { t } = useTranslation('admin');
  const location = useLocation();
  const active = isActivePath(location.pathname, item.path);

  return (
    <Link
      aria-current={active ? 'page' : undefined}
      className={adminShellStyles.navItem}
      data-active={active}
      to={item.path}
    >
      {t(item.labelKey)}
    </Link>
  );
});

NavLink.displayName = 'AdminNavLink';

const NavSection = memo<{ item: AdminNavItem }>(({ item }) => {
  const { t } = useTranslation('admin');

  if (item.children?.length) {
    return (
      <div className={adminShellStyles.navSection}>
        <div className={adminShellStyles.sideNavLabel}>{t(item.labelKey)}</div>
        {item.children.map((child) => (
          <NavLink item={child} key={child.id} />
        ))}
      </div>
    );
  }

  return <NavLink item={item} />;
});

NavSection.displayName = 'AdminNavSection';

const AdminSideNav = memo(() => {
  const { t } = useTranslation('admin');
  const { permissions } = useAdminAccess();

  const items = filterAdminNavByPermissions(ADMIN_NAV_ITEMS, permissions);

  return (
    <nav aria-label={t('nav.aria')} className={adminShellStyles.sideNav}>
      {items.map((item) => (
        <NavSection item={item} key={item.id} />
      ))}
    </nav>
  );
});

AdminSideNav.displayName = 'AdminSideNav';

export default AdminSideNav;
