const STALE_WRITE_ERROR = 'PLATFORM_REVISION_CONFLICT';

export interface AiCatalogWriteEpochGuard {
  assertCurrent: (epoch: number) => void;
  begin: () => number | null;
  invalidate: () => void;
  isCurrent: (epoch: number) => boolean;
  lock: () => void;
  unlock: () => void;
}

/**
 * Synchronous companion to React reload state.
 *
 * A committed write locks immediately, before React can render refreshPending. Incrementing the
 * epoch permanently invalidates operations and modal callbacks that captured the previous CAS.
 */
export const createAiCatalogWriteEpochGuard = (): AiCatalogWriteEpochGuard => {
  let epoch = 0;
  let locked = false;

  const isCurrent = (candidate: number) => !locked && candidate === epoch;

  return {
    assertCurrent: (candidate) => {
      if (!isCurrent(candidate)) throw new Error(STALE_WRITE_ERROR);
    },
    begin: () => (locked ? null : epoch),
    invalidate: () => {
      epoch += 1;
    },
    isCurrent,
    lock: () => {
      locked = true;
      epoch += 1;
    },
    unlock: () => {
      locked = false;
    },
  };
};
