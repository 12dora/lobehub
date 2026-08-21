'use client';

import { memo, Suspense } from 'react';

import Loading from '@/components/Loading/BrandTextLoading';
import DelayedFallback from '@/components/Loading/DelayedFallback';
import AgentTopicManager from '@/features/AgentTopicManager';

const AgentTopicsPage = memo(() => (
  <Suspense
    fallback={
      <DelayedFallback>
        <Loading debugId="AgentTopicManager" variant={'inline'} />
      </DelayedFallback>
    }
  >
    <AgentTopicManager />
  </Suspense>
));

export default AgentTopicsPage;
