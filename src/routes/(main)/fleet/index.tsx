'use client';

import { memo, Suspense } from 'react';

import Loading from '@/components/Loading/BrandTextLoading';
import DelayedFallback from '@/components/Loading/DelayedFallback';
import FleetView from '@/features/Fleet';

const FleetPage = memo(() => {
  return (
    <Suspense
      fallback={
        <DelayedFallback>
          <Loading debugId="FleetPage" variant={'inline'} />
        </DelayedFallback>
      }
    >
      <FleetView />
    </Suspense>
  );
});

FleetPage.displayName = 'FleetPage';

export default FleetPage;
