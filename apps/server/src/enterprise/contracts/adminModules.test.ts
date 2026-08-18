import { describe, expect, it } from 'vitest';

import { adminModulesUpdateInputSchema } from './adminModules';

describe('adminModules contracts', () => {
  it('strips a retired chatgptWeb key from update input instead of rejecting it', () => {
    const parsed = adminModulesUpdateInputSchema.parse({
      expectedRevision: 0,
      // leftover operator / stored payload from the retired pseudo-module
      modules: { chatgptWeb: false } as Record<string, boolean>,
    });

    expect(parsed).toEqual({ expectedRevision: 0, modules: {} });
  });
});
