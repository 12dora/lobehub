import { Suspense } from 'react';

import Loading from '@/components/Loading/BrandTextLoading';
import DelayedFallback from '@/components/Loading/DelayedFallback';
import Portal from '@/routes/(main)/agent/features/Portal/features/Portal';
import PortalPanel from '@/routes/(main)/agent/features/Portal/features/PortalPanel';

const ChatPortal = () => {
  return (
    <Portal>
      <Suspense
        fallback={
          <DelayedFallback>
            <Loading debugId={'ChatPortal'} variant={'inline'} />
          </DelayedFallback>
        }
      >
        <PortalPanel mobile={false} />
      </Suspense>
    </Portal>
  );
};

export default ChatPortal;
