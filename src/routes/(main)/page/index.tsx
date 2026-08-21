'use client';

import { memo, Suspense } from 'react';

import Loading from '@/components/Loading/BrandTextLoading';
import DelayedFallback from '@/components/Loading/DelayedFallback';
import PageExplorerPlaceholder from '@/features/PageExplorer/PageExplorerPlaceholder';

const PagesPage = memo(() => {
  return (
    <Suspense
      fallback={
        <DelayedFallback>
          <Loading debugId="PagesPage" variant={'inline'} />
        </DelayedFallback>
      }
    >
      <PageExplorerPlaceholder />
    </Suspense>
  );
});

PagesPage.displayName = 'PagesPage';

export default PagesPage;
