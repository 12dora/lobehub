// @vitest-environment node
/**
 * Pure authorization inventory for A3 retention procedures.
 * Does not import adminRouter (avoids heavy otel/runtime graph).
 */
import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { ADMIN_MUTATION_REGISTRY } from './adminMutationRegistry';
import { ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY } from './adminProcedureAuthorizationRegistry';

const RETENTION_PATHS = [
  'admin.audit.retention.cancel',
  'admin.audit.retention.dryRun',
  'admin.audit.retention.getRun',
  'admin.audit.retention.listRuns',
  'admin.audit.retention.run',
  'admin.audit.retention.status',
] as const;

describe('admin.audit.retention authorization inventory', () => {
  it('registers all six retention procedures under AUDIT_RETENTION_OPERATE', () => {
    for (const path of RETENTION_PATHS) {
      const entry = ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.find((e) => e.path === path);
      expect(entry, path).toBeDefined();
      expect(entry).toMatchObject({
        permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE] },
      });
    }

    const mutations = [
      'admin.audit.retention.cancel',
      'admin.audit.retention.dryRun',
      'admin.audit.retention.run',
    ] as const;
    for (const path of mutations) {
      const def = ADMIN_MUTATION_REGISTRY[path];
      expect(def.risk).toBe('high');
      expect(def.dangerous).toBe(true);
      expect(def.controls.reauth.status).toBe('enforced');
      expect(def.controls.reason.status).toBe('enforced');
    }
  });

  it('keeps listRuns/getRun/status as queries and dryRun/run/cancel as mutations', () => {
    expect(
      ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.find(
        (e) => e.path === 'admin.audit.retention.listRuns',
      )?.kind,
    ).toBe('query');
    expect(
      ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.find((e) => e.path === 'admin.audit.retention.getRun')
        ?.kind,
    ).toBe('query');
    expect(
      ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.find((e) => e.path === 'admin.audit.retention.status')
        ?.kind,
    ).toBe('query');
    expect(
      ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.find((e) => e.path === 'admin.audit.retention.dryRun')
        ?.kind,
    ).toBe('mutation');
    expect(
      ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.find((e) => e.path === 'admin.audit.retention.run')
        ?.kind,
    ).toBe('mutation');
    expect(
      ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.find((e) => e.path === 'admin.audit.retention.cancel')
        ?.kind,
    ).toBe('mutation');
  });
});
