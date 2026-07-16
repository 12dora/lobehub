import { describe, expect, it } from 'vitest';

import * as primitives from './index';

/**
 * PR-017: shared SectionGroup is used by settings adapter + admin overview.
 */
describe('AdminPageTemplate + SectionGroup extraction', () => {
  it('exports AdminPageTemplate adapter', () => {
    expect(primitives.AdminPageTemplate).toBeTruthy();
    expect(primitives.AdminPageTemplate.displayName).toBe('AdminPageTemplate');
  });

  it('settings StatsFormGroup is a compatibility re-export of SectionGroup', async () => {
    const shared = await import('@/components/SectionGroup');
    const adapter =
      await import('@/routes/(main)/settings/stats/features/components/StatsFormGroup');
    expect(adapter.default).toBe(shared.default);
  });

  it('primitives barrel does not re-export user settings route pages', () => {
    expect(primitives.DataTable).toBeDefined();
    expect((primitives as Record<string, unknown>).SettingsPage).toBeUndefined();
  });
});
