import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { mapEnterpriseError } from './errors/mapEnterpriseError';

/**
 * Public barrel must only re-export symbols that still exist.
 * CS-05: enterpriseModuleRegistry.register is intentionally not public —
 * desktopRoutes is a frozen module-eval snapshot.
 */
describe('enterprise client public barrel', () => {
  it('index.ts does not re-export deleted registry extension types or the register singleton', () => {
    const indexSource = readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
    expect(indexSource).not.toMatch(/EnterpriseMenuItem/);
    expect(indexSource).not.toMatch(/EnterpriseSystemCheck/);
    expect(indexSource).not.toMatch(/createEnterpriseModuleRegistry/);
    expect(indexSource).not.toMatch(/enterpriseModuleRegistry,/);
    expect(indexSource).toMatch(/export type \{[^}]*EnterpriseModuleRegistry/);
    expect(indexSource).toMatch(/mapEnterpriseError/);
  });

  it('mapEnterpriseError stays live for barrel consumers', () => {
    expect(mapEnterpriseError(new Error('unrelated'))).toBeNull();
  });
});
