import { describe, expect, it } from 'vitest';

import { createEnterpriseModuleRegistry } from './registry';

describe('enterpriseModuleRegistry', () => {
  it('starts empty so flag-off route trees stay unchanged', () => {
    const registry = createEnterpriseModuleRegistry();
    expect(registry.list()).toEqual([]);
    expect(registry.getRoutes()).toEqual([]);
    expect(registry.getMenuItems()).toEqual([]);
    expect(registry.getSystemChecks()).toEqual([]);
  });

  it('registers routes and rejects duplicate ids', () => {
    const registry = createEnterpriseModuleRegistry();
    registry.register({
      id: 'admin-shell',
      routes: [{ path: '/admin' }],
    });
    expect(registry.getRoutes()).toEqual([{ path: '/admin' }]);
    expect(() => registry.register({ id: 'admin-shell' })).toThrow(/already registered/);
  });
});
