/**
 * Non-React mirror of the platform "is this settings path locked?" bit.
 *
 * `usePlatformSettingMeta` owns the effective-settings query, but it is a hook —
 * store actions and agent-run transports have no way to read it. They must still
 * be able to fail *closed* on a managed path (e.g. a per-conversation approval
 * mode must never win over a locked organisation policy), so the hook publishes
 * the path meta here whenever the query resolves.
 *
 * "Never published" (policy disabled, or nothing has mounted a managed field
 * yet) reads as *not locked*, which matches the flag-off behaviour.
 */
let lockedPaths: ReadonlySet<string> = new Set();

/** Replace the published snapshot. Called by `usePlatformSettingMeta`'s fetcher. */
export const publishPlatformSettingLocks = (
  pathMeta: Record<string, { locked?: boolean }> | undefined,
): void => {
  lockedPaths = new Set(
    Object.entries(pathMeta ?? {})
      .filter(([, meta]) => meta?.locked === true)
      .map(([path]) => path),
  );
};

export const isPlatformSettingLocked = (path: string): boolean => lockedPaths.has(path);

/** Test-only: drop the published snapshot. */
export const resetPlatformSettingLocks = (): void => {
  lockedPaths = new Set();
};
