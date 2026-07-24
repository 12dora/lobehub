import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { mapEnterpriseError } from './errors/mapEnterpriseError';
import { createEnterpriseModuleRegistry, enterpriseModuleRegistry } from './registry';

/**
 * Public barrel must only re-export symbols that still exist.
 * Guards against deleting registry APIs while leaving stale type exports.
 * Source-level check avoids importing the full client barrel (heavy feature tree).
 */
describe('enterprise client public barrel', () => {
  it('index.ts does not re-export deleted registry extension types', () => {
    const indexSource = readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
    expect(indexSource).not.toMatch(/EnterpriseMenuItem/);
    expect(indexSource).not.toMatch(/EnterpriseSystemCheck/);
    expect(indexSource).toMatch(/createEnterpriseModuleRegistry/);
    expect(indexSource).toMatch(/enterpriseModuleRegistry/);
    expect(indexSource).toMatch(/mapEnterpriseError/);
  });

  it('registry surface used by the barrel is live', () => {
    expect(typeof createEnterpriseModuleRegistry).toBe('function');
    expect(enterpriseModuleRegistry.getRoutes()).toEqual([]);
    expect(mapEnterpriseError(new Error('unrelated'))).toBeNull();
  });
});
