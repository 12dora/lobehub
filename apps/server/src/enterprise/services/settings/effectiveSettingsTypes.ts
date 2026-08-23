/**
 * Narrow transaction lifecycle seam. Production leaves this empty; causal
 * concurrency and rollback tests use promise barriers/fault injection without
 * replacing the service or mirroring its transaction logic.
 */
export interface SettingsMutationLifecycle {
  afterBundleLock?: (operation: 'fullReset' | 'legacyUpdate' | 'patch' | 'reset') => Promise<void>;
  afterManagedOverrideWrite?: (operation: 'legacyUpdate', index: number) => Promise<void>;
  afterManagedWrites?: (operation: 'fullReset' | 'legacyUpdate') => Promise<void>;
  beforeBundleLock?: (operation: 'fullReset' | 'legacyUpdate' | 'patch' | 'reset') => Promise<void>;
  beforeLegacyBackfillCleanup?: () => Promise<void>;
  beforeLegacyWrite?: (operation: 'fullReset' | 'legacyUpdate') => Promise<void>;
  beforeOverrideRevisionBump?: (operation: 'legacyUpdate') => Promise<void>;
}
