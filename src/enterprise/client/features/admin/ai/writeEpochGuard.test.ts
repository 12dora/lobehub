import { describe, expect, it } from 'vitest';

import { createAiCatalogWriteEpochGuard } from './writeEpochGuard';

describe('AI catalog write epoch guard', () => {
  it('locks synchronously and permanently invalidates older operation epochs', () => {
    const guard = createAiCatalogWriteEpochGuard();
    const staleEpoch = guard.begin()!;

    guard.lock();
    expect(guard.begin()).toBeNull();
    expect(() => guard.assertCurrent(staleEpoch)).toThrow('PLATFORM_REVISION_CONFLICT');

    guard.unlock();
    const currentEpoch = guard.begin()!;
    expect(currentEpoch).not.toBe(staleEpoch);
    expect(() => guard.assertCurrent(staleEpoch)).toThrow('PLATFORM_REVISION_CONFLICT');
    expect(() => guard.assertCurrent(currentEpoch)).not.toThrow();
  });

  it('invalidates old callbacks without releasing an existing reload lock', () => {
    const guard = createAiCatalogWriteEpochGuard();
    const staleEpoch = guard.begin()!;

    guard.lock();
    guard.invalidate();
    expect(() => guard.assertCurrent(staleEpoch)).toThrow('PLATFORM_REVISION_CONFLICT');
    expect(guard.begin()).toBeNull();

    guard.unlock();
    expect(guard.begin()).not.toBeNull();
  });
});
