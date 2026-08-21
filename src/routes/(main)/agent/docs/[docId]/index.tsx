'use client';

import { memo, Suspense } from 'react';
import { useParams } from 'react-router';

import Loading from '@/components/Loading/BrandTextLoading';
import DelayedFallback from '@/components/Loading/DelayedFallback';
import AgentDocumentPage from '@/features/AgentDocumentPage';
import { getIdFromIdentifier } from '@/utils/identifier';

const AgentDocumentRoute = memo(() => {
  const { docId } = useParams<{ docId: string }>();
  const documentId = getIdFromIdentifier(docId ?? '', 'docs');

  return (
    <Suspense
      fallback={
        <DelayedFallback>
          <Loading debugId="AgentDocumentRoute" variant={'inline'} />
        </DelayedFallback>
      }
    >
      {/* key remounts the editor when switching between documents */}
      <AgentDocumentPage documentId={documentId} key={documentId} />
    </Suspense>
  );
});

AgentDocumentRoute.displayName = 'AgentDocumentRoute';

export default AgentDocumentRoute;
