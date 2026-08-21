'use client';

import { memo, Suspense } from 'react';

import Loading from '@/components/Loading/BrandTextLoading';
import DelayedFallback from '@/components/Loading/DelayedFallback';
import AgentUsage from '@/features/AgentUsage';

const AgentStatsPage = memo(() => (
  <Suspense
    fallback={
      <DelayedFallback>
        <Loading debugId="AgentUsage" variant={'inline'} />
      </DelayedFallback>
    }
  >
    <AgentUsage />
  </Suspense>
));

export default AgentStatsPage;
