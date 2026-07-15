import { describe, expect, it } from 'vitest';

import { DEFAULT_MANAGED_RESOURCES, MANAGED_RESOURCE_KINDS } from './managedResources';

describe('managed resources', () => {
  it('defaults all managed resource switches to false', () => {
    for (const kind of MANAGED_RESOURCE_KINDS) {
      expect(DEFAULT_MANAGED_RESOURCES[kind]).toBe(false);
    }
  });

  it('covers AI, skill, connector and agent kinds', () => {
    expect(MANAGED_RESOURCE_KINDS).toEqual([
      'aiProviders',
      'aiModels',
      'skills',
      'connectors',
      'agents',
    ]);
  });
});
