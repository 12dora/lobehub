'use client';

import { Skeleton, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import type { TFunction } from 'i18next';
import type { NavigateFunction } from 'react-router';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';

const styles = createStaticStyles(({ css }) => ({
  state: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;

    padding-block: 32px;
  `,
}));

interface UserDetailLoadingProps {
  reduceMotion: boolean | null;
  t: TFunction<'admin'>;
}

export const UserDetailLoading = ({ reduceMotion, t }: UserDetailLoadingProps) => (
  <AdminPageTemplate title={t('users.detail.loading')}>
    <div aria-label={t('primitives.dataTable.loading')} className={styles.state} role="status">
      <Skeleton title active={!reduceMotion} paragraph={{ rows: 6 }} />
    </div>
  </AdminPageTemplate>
);

interface UserDetailNotFoundProps {
  navigate: NavigateFunction;
  t: TFunction<'admin'>;
}

export const UserDetailNotFound = ({ navigate, t }: UserDetailNotFoundProps) => (
  <AdminPageTemplate title={t('users.detail.notFoundTitle')}>
    <div className={styles.state}>
      <Text>{t('users.detail.notFoundDesc')}</Text>
      <Button type="default" onClick={() => navigate('/admin/users')}>
        {t('users.detail.backToList')}
      </Button>
    </div>
  </AdminPageTemplate>
);

interface UserDetailErrorProps {
  onRetry: () => void;
  t: TFunction<'admin'>;
}

export const UserDetailError = ({ onRetry, t }: UserDetailErrorProps) => (
  <AdminPageTemplate title={t('users.detail.title')}>
    <div className={styles.state} role="alert">
      <Text>{t('primitives.dataTable.error')}</Text>
      <Button type="primary" onClick={onRetry}>
        {t('primitives.dataTable.retry')}
      </Button>
    </div>
  </AdminPageTemplate>
);

// ── Slide-in panel variants ────────────────────────────────────────────────
// Same three states without page chrome: the drawer already owns the header.

interface UserPanelLoadingProps {
  reduceMotion: boolean | null;
  t: TFunction<'admin'>;
}

export const UserPanelLoading = ({ reduceMotion, t }: UserPanelLoadingProps) => (
  <div aria-label={t('primitives.dataTable.loading')} className={styles.state} role="status">
    <Skeleton title active={!reduceMotion} paragraph={{ rows: 6 }} />
  </div>
);

interface UserPanelNotFoundProps {
  onDismiss?: () => void;
  t: TFunction<'admin'>;
}

export const UserPanelNotFound = ({ onDismiss, t }: UserPanelNotFoundProps) => (
  <div className={styles.state}>
    <Text style={{ fontWeight: 600 }}>{t('users.detail.notFoundTitle')}</Text>
    <Text type="secondary">{t('users.detail.notFoundDesc')}</Text>
    {onDismiss ? (
      <Button type="default" onClick={onDismiss}>
        {t('users.detail.closePanel')}
      </Button>
    ) : null}
  </div>
);

interface UserPanelErrorProps {
  onRetry: () => void;
  t: TFunction<'admin'>;
}

export const UserPanelError = ({ onRetry, t }: UserPanelErrorProps) => (
  <div className={styles.state} role="alert">
    <Text>{t('primitives.dataTable.error')}</Text>
    <Button type="primary" onClick={onRetry}>
      {t('primitives.dataTable.retry')}
    </Button>
  </div>
);
