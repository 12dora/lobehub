'use client';

import { Button } from '@lobehub/ui/base-ui';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import AdminBreadcrumb from './AdminBreadcrumb';
import AdminSideNav from './AdminSideNav';
import { adminShellStyles } from './style';

export interface AdminShellLayoutProps {
  children: ReactNode;
}

/**
 * Desktop admin chrome: side nav + header + content.
 * Not nested inside the main app layout.
 */
const AdminShellLayout = memo<AdminShellLayoutProps>(({ children }) => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();

  return (
    <div className={adminShellStyles.root}>
      <AdminSideNav />
      <div className={adminShellStyles.main}>
        <header className={adminShellStyles.header}>
          <div className={adminShellStyles.brand}>{t('shell.brand')}</div>
          <AdminBreadcrumb />
          <Button
            size="small"
            type="text"
            onClick={() => {
              navigate('/');
            }}
          >
            {t('shell.exit')}
          </Button>
        </header>
        <main className={adminShellStyles.content}>{children}</main>
      </div>
    </div>
  );
});

AdminShellLayout.displayName = 'AdminShellLayout';

export default AdminShellLayout;
