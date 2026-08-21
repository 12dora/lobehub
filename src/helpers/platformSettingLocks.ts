/**
 * Non-React mirror of the platform "is this settings path locked?" bit.
 *
 * `usePlatformSettingMeta` owns the effective-settings query, but it is a hook —
 * store actions and agent-run transports have no way to read it. They must still
 * be able to fail *closed* on a managed path (e.g. a per-conversation approval
 * mode must never win over a locked organisation policy), so the platform
 * bootstrap and that hook publish the path meta here.
 *
 * The mirror is deliberately a **tri-state**, because "no locked paths" and "we
 * do not know yet" have opposite safety semantics:
 *
 * - `disabled` — the deployment has no user-settings policy (community build,
 *   enterprise flag off, or capabilities say the policy is off). Nothing can be
 *   locked, so unmanaged resolution is correct.
 * - `unknown` — a policy *could* apply but the effective settings have not been
 *   answered yet (bootstrap in flight, request failed, account just changed).
 *   Callers must fail closed.
 * - `ready` — `pathMeta` below is authoritative.
 */
export type PlatformSettingLockStatus = 'disabled' | 'unknown' | 'ready';

/**
 * SWR key of the effective-settings query. Shared by the platform bootstrap
 * prime and `usePlatformSettingMeta` so both hit one cache entry — and therefore
 * one request — and can never drift apart.
 */
export const EFFECTIVE_SETTINGS_SWR_KEY = 'user.settings.effective' as const;

/**
 * Starts as `unknown`: before the platform bootstrap has classified this
 * deployment we cannot claim a path is unlocked.
 */
let status: PlatformSettingLockStatus = 'unknown';
let lockedPaths: ReadonlySet<string> = new Set();

export const getPlatformSettingLockStatus = (): PlatformSettingLockStatus => status;

/**
 * The deployment has no user-settings policy — no path can ever be locked.
 * Published by the platform bootstrap for community / flag-off deployments.
 */
export const markPlatformSettingsUnmanaged = (): void => {
  status = 'disabled';
  lockedPaths = new Set();
};

/**
 * A policy may apply but its effective state is not known (bootstrap in flight,
 * fetch failed, signed-in account or policy revision changed). Callers fail closed.
 */
export const markPlatformSettingLocksUnknown = (): void => {
  status = 'unknown';
  lockedPaths = new Set();
};

/** Publish an authoritative `pathMeta` answer. */
export const publishPlatformSettingLocks = (
  pathMeta: Record<string, { locked?: boolean }> | undefined,
): void => {
  status = 'ready';
  lockedPaths = new Set(
    Object.entries(pathMeta ?? {})
      .filter(([, meta]) => meta?.locked === true)
      .map(([path]) => path),
  );
};

export const isPlatformSettingLocked = (path: string): boolean => lockedPaths.has(path);

/**
 * True when a managed policy could apply to `path` but its state is unknown, so
 * the caller must pick the safest value rather than trusting local state.
 */
export const isPlatformSettingLockUnknown = (): boolean => status === 'unknown';

/** Test-only: drop the published snapshot back to `unknown`. */
export const resetPlatformSettingLocks = (): void => {
  markPlatformSettingLocksUnknown();
};
