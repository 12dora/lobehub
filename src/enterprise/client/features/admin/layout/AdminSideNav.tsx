'use client';

import { Accordion, AccordionItem, Flexbox, Icon, Text } from '@lobehub/ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';

import { ADMIN_NAV_ICONS } from '@/enterprise/client/nav/adminIcons';
import {
  ADMIN_NAV_ITEMS,
  type AdminNavItem,
  filterAdminNavByPermissions,
} from '@/enterprise/client/nav/adminNavMeta';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import NavItem from '@/features/NavPanel/components/NavItem';
import { isModifierClick } from '@/utils/navigation';

import { adminShellStyles } from './style';

/**
 * Single vertical rhythm for the whole side nav.
 *
 * Every adjacent pair of rows must be separated by exactly this much, whatever the group
 * boundaries are. Three places have to agree, because the Accordion contributes its own gap
 * *between* top-level entries while an expanded group's content box sits inside one of them:
 * - `Accordion gap` — top-level item ↔ top-level item, and group's last child ↔ the next
 *   top-level row (the content box adds nothing below it, see `paddingBlockEnd: 0`);
 * - the group content `Flexbox gap` — child ↔ child;
 * - the group content `paddingBlockStart` — group header ↔ its first child (`.accordion-item`
 *   is a plain flex column with no gap of its own).
 */
const NAV_ROW_GAP = 2;

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
      <NavItem active={active} icon={ADMIN_NAV_ICONS[item.id]} title={t(item.labelKey)} />
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
      <Flexbox gap={NAV_ROW_GAP} paddingInline={2}>
        <Accordion defaultExpandedKeys={defaultExpandedKeys} gap={NAV_ROW_GAP}>
          {items.map((item) => {
            if (item.children?.length) {
              return (
                <AccordionItem
                  itemKey={item.id}
                  key={item.id}
                  paddingBlock={4}
                  paddingInline={'8px 4px'}
                  title={
                    <Flexbox horizontal align="center" gap={8}>
                      {ADMIN_NAV_ICONS[item.id] ? (
                        <Icon icon={ADMIN_NAV_ICONS[item.id]} size={16} />
                      ) : null}
                      <Text ellipsis fontSize={12} type="secondary" weight={500}>
                        {t(item.labelKey)}
                      </Text>
                    </Flexbox>
                  }
                >
                  <Flexbox gap={NAV_ROW_GAP} style={{ paddingBlockStart: NAV_ROW_GAP }}>
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
