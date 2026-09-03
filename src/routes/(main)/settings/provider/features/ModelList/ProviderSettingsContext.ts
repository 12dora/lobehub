import { createContext, type ReactNode } from 'react';

export interface ProviderSettingsContextValue {
  /**
   * When true, these components are rendering the ADMIN platform catalog rather than a
   * member's own provider settings. Supplied by the admin surface only.
   *
   * Read by {@link useManagedAiModels}: the managed-resource capability is global, so the
   * admin catalog needs an explicit marker to stay editable under its own policy.
   */
  adminPlatformCatalog?: boolean;
  /**
   * Override for the "delete provider" confirmation body. Supplied by the admin platform
   * catalog, where a delete is site-wide and purges credentials plus version history — a much
   * heavier consequence than deleting a personal provider. Absent = the normal user copy.
   */
  deleteConfirmDescription?: string;
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
