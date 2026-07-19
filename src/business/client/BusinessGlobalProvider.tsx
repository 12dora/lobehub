import { type ReactNode } from 'react';

import { EnterprisePlatformProvider } from '@/enterprise/client/providers';
import DynamicFavicon from '@/layout/GlobalProvider/DynamicFavicon';
import { FaviconProvider } from '@/layout/GlobalProvider/FaviconProvider';

import DefaultInboxBrandingSync from './DefaultInboxBrandingSync';

export default function BusinessGlobalProvider({ children }: { children: ReactNode }) {
  return (
    <EnterprisePlatformProvider
      initialPublicSnapshot={window.__SERVER_CONFIG__?.platformPublicSnapshot}
    >
      <DefaultInboxBrandingSync />
      <FaviconProvider>
        <DynamicFavicon />
        {children}
      </FaviconProvider>
    </EnterprisePlatformProvider>
  );
}
