import { type ReactNode } from 'react';

import { EnterprisePlatformProvider } from '@/enterprise/client/providers';
import { FaviconProvider } from '@/layout/GlobalProvider/FaviconProvider';
import type { PlatformPublicSnapshot } from '@/types/platform/publicSnapshot';

interface BusinessAuthProviderProps {
  children: ReactNode;
  initialPublicSnapshot?: PlatformPublicSnapshot;
}

export default function BusinessAuthProvider({
  children,
  initialPublicSnapshot,
}: BusinessAuthProviderProps) {
  return (
    <EnterprisePlatformProvider initialPublicSnapshot={initialPublicSnapshot}>
      <FaviconProvider>{children}</FaviconProvider>
    </EnterprisePlatformProvider>
  );
}
