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
