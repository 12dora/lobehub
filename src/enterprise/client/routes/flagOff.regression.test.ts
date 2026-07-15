import { describe, expect, it } from 'vitest';

import { BusinessDesktopRoutesWithoutMainLayout } from '@/business/client/BusinessDesktopRoutes';

import { EnterpriseDesktopRoutesWithoutMainLayout } from './index';

/**
 * Flag-off regression: enterprise route injection must not add paths.
 * ENABLE_PLATFORM_ADMIN defaults off and no modules register in M00.
 */
describe('enterprise routes flag-off regression', () => {
  it('enterprise static routes stay empty', () => {
    expect(EnterpriseDesktopRoutesWithoutMainLayout).toEqual([]);
  });

  it('BusinessDesktopRoutesWithoutMainLayout stays empty (upstream-compatible)', () => {
    expect(BusinessDesktopRoutesWithoutMainLayout).toEqual([]);
    expect(BusinessDesktopRoutesWithoutMainLayout).toHaveLength(0);
  });
});
