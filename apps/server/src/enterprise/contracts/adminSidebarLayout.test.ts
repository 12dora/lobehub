// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  adminSidebarLayoutGetOutputSchema,
  adminSidebarLayoutUpdateInputSchema,
} from './adminSidebarLayout';

describe('admin sidebar layout contracts', () => {
  it('accepts direct-save get/update documents with CAS revision fields', () => {
    expect(
      adminSidebarLayoutGetOutputSchema.parse({
        layout: null,
        mode: 'user',
        revision: 0,
      }),
    ).toEqual({ layout: null, mode: 'user', revision: 0 });

    expect(
      adminSidebarLayoutUpdateInputSchema.parse({
        expectedRevision: 0,
        layout: {
          hiddenSidebarSections: [],
          sidebarItems: ['chat', 'settings'],
        },
        mode: 'platform',
      }),
    ).toMatchObject({ expectedRevision: 0, mode: 'platform' });
  });

  it('requires revision on get output and expectedRevision on update input', () => {
    expect(
      adminSidebarLayoutGetOutputSchema.safeParse({
        layout: null,
        mode: 'user',
      }).success,
    ).toBe(false);

    expect(
      adminSidebarLayoutUpdateInputSchema.safeParse({
        layout: null,
        mode: 'user',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      adminSidebarLayoutUpdateInputSchema.safeParse({
        expectedRevision: 1,
        extra: true,
        layout: null,
        mode: 'user',
      }).success,
    ).toBe(false);
  });
});
