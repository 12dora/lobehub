import { type ReactNode } from 'react';

import { EnterpriseBusinessGlobalProvider } from '@/enterprise/client/providers/EnterpriseBusinessGlobalProvider';

/** Declarative business mount — implementation lives under enterprise. */
export default function BusinessGlobalProvider({ children }: { children: ReactNode }) {
  return <EnterpriseBusinessGlobalProvider>{children}</EnterpriseBusinessGlobalProvider>;
}
