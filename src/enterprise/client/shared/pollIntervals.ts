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
 *  - a poll that drives a page the deployment can switch off must also be gated on the module;
 *  - **every** entry is additionally gated on the tab being visible and online, through
 *    `useVisiblePoll` (see `./useVisiblePoll.ts`) — a background tab costs nothing.
 */
export const ADMIN_POLL_INTERVALS = {
  /** `admin.audit.*` lists, only while an item is pending/running (+ visible). */
  auditList: 4000,
  /**
   * `platform.getCapabilities` — managed-resource enforcement + module state (authed).
   *
   * Deliberately the SAME cadence as `publicSnapshot`: both polls are started by the same hook in
   * the same render, so their timers stay in lockstep and the tRPC batch link folds the two
   * procedure calls into ONE HTTP request per tick. Changing one without the other doubles the
   * idle request count of every open tab.
   */
  capabilities: 120_000,
  /** Identity-provider test/restart status while a restart is converging (+ visible). */
  identityProviderRestart: 1500,
  /** Identity-provider auth snapshot while a change is pending (+ visible). */
  identityProviderSnapshot: 2000,
  /** `admin.system.getJobs`, only while a job is active (+ visible). */
  jobs: 3000,
  /**
   * `admin.system.getStatus` dependency cards. Server memo is 30s; this keeps the
   * page current without waiting for a manual refresh or the jobs poll.
   */
  systemStatus: 30_000,
  /**
   * Module restart convergence, only while a restart is in flight (+ visible). The loop pauses
   * while the tab is hidden — including its convergence budget — and resumes on refocus.
   */
  moduleRestart: 3000,
  /** 网络代理 live status — gated on page visibility AND the `networkProxy` module. */
  networkProxyStatus: 15_000,
  /**
   * `platform.getPublicSnapshot` — branding / login options, polled for anonymous visitors too,
   * i.e. on the sign-in page of every deployment. Kept in lockstep with `capabilities` (see there).
   */
  publicSnapshot: 120_000,
} as const;

export type AdminPollInterval = keyof typeof ADMIN_POLL_INTERVALS;
