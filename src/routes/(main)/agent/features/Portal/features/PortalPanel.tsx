import { memo, Suspense } from 'react';

import Loading from '@/components/Loading/BrandTextLoading';
import DelayedFallback from '@/components/Loading/DelayedFallback';

import DesktopLayout from '../_layout/Desktop';
import MobileLayout from '../_layout/Mobile';

interface PortalPanelProps {
  mobile?: boolean;
}

const PortalPanel = memo<PortalPanelProps>(({ mobile }) => {
  const Layout = mobile ? MobileLayout : DesktopLayout;

  return (
    <Suspense
      fallback={
        <DelayedFallback>
          <Loading debugId="PortalPanel" variant={'inline'} />
        </DelayedFallback>
      }
    >
      <Layout />
    </Suspense>
  );
});

PortalPanel.displayName = 'PortalPanel';

export default PortalPanel;
