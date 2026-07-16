import { describe, expect, it } from 'vitest';

import * as primitives from './index';

/**
 * PR-017: document the extraction boundary without importing user settings routes.
 * Admin modules must use AdminPageTemplate / primitives — never settings page entries.
 */
describe('AdminPageTemplate boundary', () => {
  it('exports a dedicated admin presentation adapter (no settings route import)', () => {
    expect(primitives.AdminPageTemplate).toBeTruthy();
    expect(primitives.AdminPageTemplate.displayName).toBe('AdminPageTemplate');
  });

  it('primitives barrel does not re-export user settings routes', () => {
    expect(primitives.AdminPageTemplate).toBeDefined();
    expect(primitives.DataTable).toBeDefined();
    expect(primitives.FilterBar).toBeDefined();
    expect(primitives.StatusBadge).toBeDefined();
    expect(primitives.RevisionBanner).toBeDefined();
    expect(primitives.openDangerConfirm).toBeDefined();
    // Ensure we did not accidentally export a settings page symbol
    expect((primitives as Record<string, unknown>).SettingsPage).toBeUndefined();
    expect((primitives as Record<string, unknown>).Common).toBeUndefined();
  });
});
