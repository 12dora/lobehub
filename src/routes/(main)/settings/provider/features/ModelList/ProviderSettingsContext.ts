import { createContext, type ReactNode } from 'react';

export interface ProviderSettingsContextValue {
  /**
   * When true (admin platform catalog), hide client-side fetch toggle — no global equivalent.
   */
  hideFetchOnClient?: boolean;
  /**
   * When true (admin platform catalog), suppress the personal OAuth device-flow connect
   * panel: it writes credentials into the viewer's personal key vault, not the platform
   * catalog. The platform-side connect UI is supplied through `sharedOAuthPanel`.
   */
  hidePersonalAuth?: boolean;
  modelEditable?: boolean;
  sdkType?: string;
  /**
   * Platform secret is configured without plaintext (admin). Show non-revealing API key placeholder.
   */
  secretConfigured?: boolean;
  /**
   * Render slot for the platform-owned (shared account) OAuth connect panel of
   * rotating-refresh providers. Supplied by the admin surface only — keeps the
   * enterprise implementation out of these shared route components.
   */
  sharedOAuthPanel?: (providerId: string) => ReactNode;
  showAddNewModel?: boolean;
  showDeployName?: boolean;
  showModelFetcher?: boolean;
}

export const ProviderSettingsContext = createContext<ProviderSettingsContextValue>({});
