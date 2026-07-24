// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  adminSidebarLayoutGetOutputSchema,
  adminSidebarLayoutUpdateInputSchema,
} from './adminSidebarLayout';

describe('admin sidebar layout contracts', () => {
  it('accepts direct-save get/update documents without CAS revision fields', () => {
    // platform_sidebar_layout has no revision column; CAS is a known follow-up.
    expect(
      adminSidebarLayoutGetOutputSchema.parse({
        layout: null,
        mode: 'user',
      }),
    ).toEqual({ layout: null, mode: 'user' });

    expect(
      adminSidebarLayoutUpdateInputSchema.parse({
        layout: {
          hiddenSidebarSections: [],
          sidebarItems: ['chat', 'settings'],
        },
        mode: 'platform',
      }),
    ).toMatchObject({ mode: 'platform' });

    // Strict schema rejects unknown CAS fields until server-side revision exists.
    expect(
      adminSidebarLayoutUpdateInputSchema.safeParse({
        expectedRevision: 1,
        layout: null,
        mode: 'user',
      }).success,
    ).toBe(false);

    expect(
      adminSidebarLayoutGetOutputSchema.safeParse({
        layout: null,
        mode: 'user',
        revision: 0,
      }).success,
    ).toBe(false);
  });
});
