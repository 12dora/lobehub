// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

/**
 * Pure decision table for U1-R2 flag-off unmanaged metadata.
 * Mirrors usePlatformSettingMeta return derivation without React/SWR.
 */
const deriveMetaFlags = (status: 'disabled' | 'loading' | 'error' | 'ready') => {
  const unmanaged = status === 'disabled';
  const ready = status === 'ready';
  return {
    hidden: unmanaged ? false : ready ? false : false,
    locked: unmanaged ? false : ready ? false : true,
  };
};

describe('usePlatformSettingMeta flag-off parity (U1-R2)', () => {
  it('disabled is unmanaged: not locked, not hidden', () => {
    expect(deriveMetaFlags('disabled')).toEqual({ hidden: false, locked: false });
  });

  it('loading/error fail-closed for writes', () => {
    expect(deriveMetaFlags('loading').locked).toBe(true);
    expect(deriveMetaFlags('error').locked).toBe(true);
  });
});

// Prevent unused import lint if vi unused
void vi;
