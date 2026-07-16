'use client';

import { Accordion, AccordionItem, Flexbox, Text } from '@lobehub/ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';

import {
  ADMIN_NAV_ITEMS,
  type AdminNavItem,
  filterAdminNavByPermissions,
} from '@/enterprise/client/nav/adminNavMeta';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import NavItem from '@/features/NavPanel/components/NavItem';
import { isModifierClick } from '@/utils/navigation';

import { adminShellStyles } from './style';

const isActivePath = (pathname: string, itemPath: string) => {
  if (itemPath === '/admin') return pathname === '/admin' || pathname === '/admin/';
  if (itemPath.includes(':')) return false;
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`);
};

const AdminNavLink = memo<{ item: AdminNavItem }>(({ item }) => {
  const { t } = useTranslation('admin');
  const location = useLocation();
  const navigate = useNavigate();
  const active = isActivePath(location.pathname, item.path);

  return (
    <Link
      aria-current={active ? 'page' : undefined}
      to={item.path}
      onClick={(e) => {
        if (isModifierClick(e)) return;
        e.preventDefault();
        navigate(item.path);
      }}
    >
      <NavItem active={active} title={t(item.labelKey)} />
    </Link>
  );
});

AdminNavLink.displayName = 'AdminNavLink';

const AdminSideNav = memo(() => {
  const { t } = useTranslation('admin');
  const { permissions } = useAdminAccess();

  const items = useMemo(
    () => filterAdminNavByPermissions(ADMIN_NAV_ITEMS, permissions),
    [permissions],
  );

  const defaultExpandedKeys = useMemo(
    () => items.filter((item) => item.children?.length).map((item) => item.id),
    [items],
  );

  return (
    <nav aria-label={t('nav.aria')} className={adminShellStyles.sideNav}>
      <Flexbox gap={4} paddingInline={2}>
        <Accordion defaultExpandedKeys={defaultExpandedKeys} gap={8}>
          {items.map((item) => {
            if (item.children?.length) {
              return (
                <AccordionItem
                  itemKey={item.id}
                  key={item.id}
                  paddingBlock={4}
                  paddingInline={'8px 4px'}
                  title={
                    <Text ellipsis fontSize={12} type="secondary" weight={500}>
                      {t(item.labelKey)}
                    </Text>
                  }
                >
                  <Flexbox gap={1} paddingBlock={1}>
                    {item.children.map((child) => (
                      <AdminNavLink item={child} key={child.id} />
                    ))}
                  </Flexbox>
                </AccordionItem>
              );
            }

            return <AdminNavLink item={item} key={item.id} />;
          })}
        </Accordion>
      </Flexbox>
    </nav>
  );
});

AdminSideNav.displayName = 'AdminSideNav';

export default AdminSideNav;
