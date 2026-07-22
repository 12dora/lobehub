// @vitest-environment node
/**
 * Pure authorization inventory for A3 export procedures.
 * Does not import adminRouter (avoids heavy otel/runtime graph).
 */
import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { ADMIN_MUTATION_REGISTRY } from './adminMutationRegistry';
import { ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY } from './adminProcedureAuthorizationRegistry';

const EXPORT_PATHS = [
  'admin.audit.exports.cancel',
  'admin.audit.exports.create',
  'admin.audit.exports.download',
  'admin.audit.exports.get',
  'admin.audit.exports.list',
] as const;

describe('admin.audit.exports authorization inventory', () => {
  it('registers all five export procedures under AUDIT_EXPORT', () => {
    for (const path of EXPORT_PATHS) {
      const entry = ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.find((e) => e.path === path);
      expect(entry, path).toBeDefined();
      expect(entry).toMatchObject({
        permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_EXPORT] },
      });
    }

    const mutations = [
      'admin.audit.exports.cancel',
      'admin.audit.exports.create',
      'admin.audit.exports.download',
    ] as const;
    for (const path of mutations) {
      const def = ADMIN_MUTATION_REGISTRY[path];
      expect(def.risk).toBe('high');
      expect(def.dangerous).toBe(true);
      expect(def.controls.reauth.status).toBe('enforced');
      expect(def.controls.reason.status).toBe('enforced');
    }
  });

  it('keeps list/get as queries and create/download/cancel as mutations', () => {
    expect(
      ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.find((e) => e.path === 'admin.audit.exports.list')
        ?.kind,
    ).toBe('query');
    expect(
      ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.find((e) => e.path === 'admin.audit.exports.get')
        ?.kind,
    ).toBe('query');
    expect(
      ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.find((e) => e.path === 'admin.audit.exports.create')
        ?.kind,
    ).toBe('mutation');
    expect(
      ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.find((e) => e.path === 'admin.audit.exports.download')
        ?.kind,
    ).toBe('mutation');
    expect(
      ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.find((e) => e.path === 'admin.audit.exports.cancel')
        ?.kind,
    ).toBe('mutation');
  });
});
