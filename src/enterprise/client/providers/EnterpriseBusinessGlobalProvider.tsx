'use client';

import { type ReactNode } from 'react';

import DynamicFavicon from '@/layout/GlobalProvider/DynamicFavicon';
import { FaviconProvider } from '@/layout/GlobalProvider/FaviconProvider';

import DefaultInboxBrandingSync from '../features/branding/DefaultInboxBrandingSync';
import EnterprisePlatformProvider from './EnterprisePlatformProvider';

/**
 * Enterprise-owned global provider composition for the business SPA shell.
 * `src/business/client/BusinessGlobalProvider` is a one-line mount-point re-export.
 */
export function EnterpriseBusinessGlobalProvider({ children }: { children: ReactNode }) {
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
