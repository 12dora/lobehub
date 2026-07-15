import { describe, expect, it, vi } from 'vitest';

import { BusinessDesktopRoutesWithoutMainLayout } from '@/business/client/BusinessDesktopRoutes';

import { fetchPlatformCapabilities, fetchPlatformPublicSnapshot } from '../services/platform';
import { EnterpriseDesktopRoutesWithoutMainLayout } from './index';

vi.mock('../services/platform', () => ({
  fetchPlatformCapabilities: vi.fn(async () => ({})),
  fetchPlatformPublicSnapshot: vi.fn(async () => ({})),
}));

/**
 * Flag-off regression: enterprise route injection must not add paths,
 * and platform client adapters must not be invoked by route mount alone.
 * ENABLE_PLATFORM_ADMIN defaults off and no modules register in M00.
 *
 * Network gate is also covered in EnterprisePlatformProvider.test.tsx
 * (zero fetch when serverConfig.enterprise.enabled is false).
 */
describe('enterprise routes flag-off regression', () => {
  it('enterprise static routes stay empty', () => {
    expect(EnterpriseDesktopRoutesWithoutMainLayout).toEqual([]);
  });

  it('BusinessDesktopRoutesWithoutMainLayout stays empty (upstream-compatible)', () => {
    expect(BusinessDesktopRoutesWithoutMainLayout).toEqual([]);
    expect(BusinessDesktopRoutesWithoutMainLayout).toHaveLength(0);
  });

  it('flags all off: platform fetch helpers are not auto-invoked by this module', () => {
    // Importing routes/business mounts must not trigger platform network.
    expect(fetchPlatformCapabilities).not.toHaveBeenCalled();
    expect(fetchPlatformPublicSnapshot).not.toHaveBeenCalled();
  });
});
