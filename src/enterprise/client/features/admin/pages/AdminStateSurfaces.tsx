'use client';

import { FluentEmoji } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import NeuralNetworkLoading from '@/components/NeuralNetworkLoading';

import { adminShellStyles } from '../layout/style';

const StateCenter = memo<{ children: ReactNode }>(({ children }) => {
  return <div className={adminShellStyles.stateCenter}>{children}</div>;
});

StateCenter.displayName = 'AdminStateCenter';

export const AdminLoadingSurface = memo(() => {
  const { t } = useTranslation('admin');
  return (
    <StateCenter>
      <NeuralNetworkLoading size={32} />
      <div>{t('access.loading')}</div>
    </StateCenter>
  );
});

AdminLoadingSurface.displayName = 'AdminLoadingSurface';

export const AdminSignInRedirectSurface = memo(() => {
  const { t } = useTranslation('admin');
  return (
    <StateCenter>
      <NeuralNetworkLoading size={32} />
      <div>{t('access.signInRedirect')}</div>
    </StateCenter>
  );
});

AdminSignInRedirectSurface.displayName = 'AdminSignInRedirectSurface';

export const AdminForbiddenSurface = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  return (
    <StateCenter>
      <FluentEmoji emoji="🚫" size={56} />
      <h2 style={{ fontWeight: 700, margin: 0 }}>{t('access.forbidden.title')}</h2>
      <p style={{ maxWidth: 420, margin: 0 }}>{t('access.forbidden.desc')}</p>
      <Button type="primary" onClick={() => navigate('/')}>
        {t('page.backHome')}
      </Button>
    </StateCenter>
  );
});

AdminForbiddenSurface.displayName = 'AdminForbiddenSurface';

export const AdminAccessErrorSurface = memo<{
  onRetry?: () => void;
  retryable?: boolean;
}>(({ onRetry, retryable }) => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  return (
    <StateCenter>
      <FluentEmoji emoji="⚠️" size={56} />
      <h2 style={{ fontWeight: 700, margin: 0 }}>{t('access.error.title')}</h2>
      <p style={{ maxWidth: 420, margin: 0 }}>{t('access.error.desc')}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        {retryable && onRetry ? (
          <Button type="primary" onClick={onRetry}>
            {t('access.error.retry')}
          </Button>
        ) : null}
        <Button onClick={() => navigate('/')}>{t('page.backHome')}</Button>
      </div>
    </StateCenter>
  );
});

AdminAccessErrorSurface.displayName = 'AdminAccessErrorSurface';

export const AdminFeatureOffSurface = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  return (
    <StateCenter>
      <FluentEmoji emoji="🔒" size={56} />
      <h2 style={{ fontWeight: 700, margin: 0 }}>{t('feature.off.title')}</h2>
      <p style={{ maxWidth: 420, margin: 0 }}>{t('feature.off.desc')}</p>
      <Button type="primary" onClick={() => navigate('/')}>
        {t('page.backHome')}
      </Button>
    </StateCenter>
  );
});

AdminFeatureOffSurface.displayName = 'AdminFeatureOffSurface';

export const AdminMobileUnsupportedSurface = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  return (
    <StateCenter>
      <FluentEmoji emoji="💻" size={56} />
      <h2 style={{ fontWeight: 700, margin: 0 }}>{t('mobile.unsupported.title')}</h2>
      <p style={{ maxWidth: 420, margin: 0 }}>{t('mobile.unsupported.desc')}</p>
      <Button
        type="primary"
        onClick={() => {
          navigate('/');
        }}
      >
        {t('page.backHome')}
      </Button>
    </StateCenter>
  );
});

AdminMobileUnsupportedSurface.displayName = 'AdminMobileUnsupportedSurface';

// Named export used by BusinessMobileRoutes mount

export const AdminPageForbiddenSurface = memo(() => {
  const { t } = useTranslation('admin');
  return (
    <StateCenter>
      <FluentEmoji emoji="🚫" size={48} />
      <h2 style={{ fontWeight: 700, margin: 0 }}>{t('page.forbidden.title')}</h2>
      <p style={{ maxWidth: 420, margin: 0 }}>{t('page.forbidden.desc')}</p>
    </StateCenter>
  );
});

AdminPageForbiddenSurface.displayName = 'AdminPageForbiddenSurface';

export const AdminNotFoundSurface = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  return (
    <StateCenter>
      <FluentEmoji emoji="👀" size={48} />
      <h2 style={{ fontWeight: 700, margin: 0 }}>{t('notFound.title')}</h2>
      <p style={{ maxWidth: 420, margin: 0 }}>{t('notFound.desc')}</p>
      <Button type="primary" onClick={() => navigate('/admin')}>
        {t('nav.overview')}
      </Button>
    </StateCenter>
  );
});

AdminNotFoundSurface.displayName = 'AdminNotFoundSurface';
