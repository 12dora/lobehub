/**
 * Every automatic poll the admin console runs, in one place.
 *
 * Scattered `refreshInterval` literals made the console's idle cost invisible: an open tab was
 * quietly issuing a request every 1.5s–60s from six different files. Centralising them makes
 * the total legible and gives one place to slow everything down for a small deployment.
 *
 * This module deliberately sits above `features/` so the provider layer can import it too: the
 * capability and public-snapshot cadences are polled for every signed-in (and every anonymous)
 * visitor, which makes them the two most expensive entries in the table — they belong in it, not
 * beside it.
 *
 * There is no client-side override channel today (`window.__SERVER_CONFIG__.clientEnv` carries
 * only market / pyodide / S3 paths and is a typed upstream surface). If one is ever needed,
 * add the field there and read it here — do not reintroduce per-file literals.
 *
 * Rules of thumb:
 *  - anything polled for an anonymous visitor must be the slowest (public snapshot);
 *  - a poll that only makes sense while a job is in flight must be gated on that, not on time;
 *  - a poll that drives a page the deployment can switch off must also be gated on the module.
 */
export const ADMIN_POLL_INTERVALS = {
  /** `admin.audit.*` lists, only while an item is pending/running. */
  auditList: 4000,
  /** `platform.getCapabilities` — managed-resource enforcement + module state (authed). */
  capabilities: 60_000,
  /** Identity-provider status while a restart is converging. */
  identityProviderRestart: 1500,
  /** Identity-provider auth snapshot while a change is pending. */
  identityProviderSnapshot: 2000,
  /** `admin.system.getJobs`, only while a job is active. */
  jobs: 3000,
  /** Module restart convergence, only while a restart is in flight. */
  moduleRestart: 3000,
  /** 网络代理 live status — gated on page visibility AND the `networkProxy` module. */
  networkProxyStatus: 15_000,
  /** `platform.getPublicSnapshot` — branding / login options, polled for anonymous visitors too. */
  publicSnapshot: 30_000,
} as const;

export type AdminPollInterval = keyof typeof ADMIN_POLL_INTERVALS;
