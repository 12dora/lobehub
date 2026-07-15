import { type ReactNode } from 'react';

import { EnterprisePlatformProvider } from '@/enterprise/client/providers';

export default function BusinessGlobalProvider({ children }: { children: ReactNode }) {
  return <EnterprisePlatformProvider>{children}</EnterprisePlatformProvider>;
}
