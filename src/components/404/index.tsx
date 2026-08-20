'use client';

import { Button, Flexbox, FluentEmoji } from '@lobehub/ui';
import { type ReactNode } from 'react';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { MAX_WIDTH } from '@/const/layoutTokens';
import { authSpaRoutes } from '@/libs/next/nextjsOnlyRoutes';

/**
 * This screen is rendered from both SPAs. The standalone auth SPA
 * (`/signin`, `/oauth/...`, …) has no `/` route of its own, so "back home"
 * there has to stay a document load that hands off to the main app; inside the
 * main SPA it is a client-side navigation.
 */
const isAuthSpaPathname = (pathname: string) =>
  authSpaRoutes.some((route) => pathname === route || pathname.startsWith(`${route}/`));

const NotFound = memo<{
  desc?: string;
  extra?: ReactNode;
  status?: number | string;
  title?: string;
}>(({ extra, status = 404, title, desc }) => {
  const { t } = useTranslation('error');
  const navigate = useNavigate();

  const backHome = useCallback(() => {
    if (typeof window !== 'undefined' && isAuthSpaPathname(window.location.pathname)) {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- cross-SPA hop: the auth bundle cannot render `/` itself
      window.location.href = '/';
      return;
    }
    navigate('/');
  }, [navigate]);

  return (
    <Flexbox align={'center'} justify={'center'} style={{ minHeight: '100%', width: '100%' }}>
      <h1
        style={{
          filter: 'blur(8px)',
          fontSize: `min(${MAX_WIDTH / 3}px, 50vw)`,
          fontWeight: 'bolder',
          margin: 0,
          opacity: 0.12,
          position: 'absolute',
          zIndex: 0,
        }}
      >
        {status}
      </h1>
      <FluentEmoji emoji={'👀'} size={64} />
      <h2 style={{ fontWeight: 'bold', marginTop: '1em', textAlign: 'center' }}>
        {title || t('notFound.title')}
      </h2>
      <div style={{ lineHeight: '1.8', marginBottom: '2em', textAlign: 'center' }}>
        <div>{desc || t('notFound.desc')}</div>
        <div style={{ marginTop: '0.5em' }}>{t('notFound.check')}</div>
      </div>
      {extra || (
        <Button type={'primary'} onClick={backHome}>
          {t('notFound.backHome')}
        </Button>
      )}
    </Flexbox>
  );
});

NotFound.displayName = 'NotFound';

export default NotFound;
