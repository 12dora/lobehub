/**
 * Synchronous boot gate for `/admin` route registration.
 *
 * Reads `window.__SERVER_CONFIG__` injected by the SPA HTML template **before**
 * the SPA entry evaluates. Must not use NEXT_PUBLIC_*, raw env flag maps,
 * roles/permissions, or async capability fetches.
 *
 * `enterprise.platformAdmin` is feature existence only — never authorization.
 */
export const isPlatformAdminBootEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;

  try {
    const boot = window.__SERVER_CONFIG__;
    return boot?.config?.enterprise?.platformAdmin === true;
  } catch {
    return false;
  }
};
