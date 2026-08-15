'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { isCustomBranding } from '@/const/version';
import { ManagedResourceBoundary } from '@/features/ManagedResources';

import DesktopLayout from '../_layout/Desktop';
import MobileLayout from '../_layout/Mobile';
import ProviderDetailPage from '../detail';
import Footer from './Footer';

const Page = (props: { mobile?: boolean }) => {
  const [SearchParams, setSearchParams] = useSearchParams();
  const [provider, setProviderState] = useState(SearchParams.get('provider') || 'all');
  const setProvider = (provider: string) => {
    setSearchParams({ active: 'provider', provider });
    setProviderState(provider);
  };

  const { mobile } = props;
  const ProviderLayout = mobile ? MobileLayout : DesktopLayout;

  const ProviderListPage = useMemo(() => {
    return <ProviderDetailPage id={provider} onProviderSelect={setProvider} />;
  }, [provider]);

  // This page is also mounted directly (mobile settings tab, workspace settings, the bare
  // `(list)` route), i.e. outside the desktop provider layout that carries the boundary.
  // Under 平台托管 every provider-settings entry point must be blocked, not just one.
  return (
    <ManagedResourceBoundary resource="aiProviders">
      <ProviderLayout onProviderSelect={setProvider}>
        {ProviderListPage}
        {!isCustomBranding && <Footer />}
      </ProviderLayout>
    </ManagedResourceBoundary>
  );
};

export default Page;
