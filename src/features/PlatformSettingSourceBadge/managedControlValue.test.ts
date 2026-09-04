// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { resolveManagedBoolean } from './managedControlValue';
import type { PlatformSettingMetaState } from './usePlatformSettingMeta';

const state = (overrides: Partial<PlatformSettingMetaState>): PlatformSettingMetaState =>
  ({ locked: false, status: 'ready', ...overrides }) as PlatformSettingMetaState;

describe('resolveManagedBoolean', () => {
  it('keeps the stored value on an unlocked path, whatever the policy resolved', () => {
    expect(resolveManagedBoolean(state({ effectiveValue: false }), true)).toBe(true);
    expect(resolveManagedBoolean(state({ effectiveValue: true }), false)).toBe(false);
  });

  it('renders the enforced value on a locked path instead of the stored one', () => {
    expect(resolveManagedBoolean(state({ effectiveValue: false, locked: true }), true)).toBe(false);
    expect(resolveManagedBoolean(state({ effectiveValue: true, locked: true }), false)).toBe(true);
  });

  it.each([
    ['unknown', undefined],
    ['a non-boolean', 'true'],
  ])('falls back to the safe default when a locked value is %s', (_case, effectiveValue) => {
    // Loading / errored policies land here too: `locked` is already fail-closed, so the
    // control shows the safe value rather than the store's pre-policy one.
    expect(resolveManagedBoolean(state({ effectiveValue, locked: true }), true)).toBe(false);
    expect(resolveManagedBoolean(state({ effectiveValue, locked: true }), true, true)).toBe(true);
  });
});
