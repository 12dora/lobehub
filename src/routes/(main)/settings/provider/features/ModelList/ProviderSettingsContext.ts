import { createContext } from 'react';

export interface ProviderSettingsContextValue {
  /**
   * When true (admin platform catalog), hide client-side fetch toggle — no global equivalent.
   */
  hideFetchOnClient?: boolean;
  modelEditable?: boolean;
  sdkType?: string;
  /**
   * Platform secret is configured without plaintext (admin). Show non-revealing API key placeholder.
   */
  secretConfigured?: boolean;
  showAddNewModel?: boolean;
  showDeployName?: boolean;
  showModelFetcher?: boolean;
}

export const ProviderSettingsContext = createContext<ProviderSettingsContextValue>({});
