/** Local dirty epoch for the anonymous public snapshot (branding + auth-settings). */
let publicSnapshotEpoch = 0;
const listeners = new Set<() => void>();

export const getPlatformPublicSnapshotEpoch = (): number => publicSnapshotEpoch;

export const invalidatePlatformPublicSnapshot = (): void => {
  publicSnapshotEpoch += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // listeners are best-effort (drop in-process slots)
    }
  }
};

export const onPlatformPublicSnapshotInvalidate = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Test helper. Does not drop listeners — the resolver registers one at import. */
export const resetPlatformPublicSnapshotEpochForTest = (): void => {
  publicSnapshotEpoch = 0;
};
