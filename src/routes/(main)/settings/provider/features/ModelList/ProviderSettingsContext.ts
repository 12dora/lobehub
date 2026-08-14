import { createContext } from 'react';

export interface ProviderSettingsContextValue {
  /**
   * When true (admin platform catalog), hide client-side fetch toggle — no global equivalent.
   */
  hideFetchOnClient?: boolean;
  /**
   * When true (admin platform catalog), suppress the personal OAuth device-flow connect
   * panel — it writes credentials into the viewer's personal key vault, not the platform
   * catalog — and render personal-OAuth-only providers (chatgpt/supergrok) as
   * not-platform-manageable instead of showing an enable toggle that cannot succeed.
   */
  hidePersonalAuth?: boolean;
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
