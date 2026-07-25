// @vitest-environment node
/**
 * Risk-control inventory for A3 retention mutations.
 * Permission/kind facts are owned by adminProcedureAuthorizationRegistry reconciliation.
 */
import { describe, expect, it } from 'vitest';

import { ADMIN_MUTATION_REGISTRY } from './adminMutationRegistry';

const RETENTION_MUTATIONS = [
  'admin.audit.retention.cancel',
  'admin.audit.retention.dryRun',
  'admin.audit.retention.run',
] as const;

describe('admin.audit.retention risk inventory', () => {
  it('keeps retention mutations high-risk with enforced reauth and reason', () => {
    for (const path of RETENTION_MUTATIONS) {
      const def = ADMIN_MUTATION_REGISTRY[path];
      expect(def.risk).toBe('high');
      expect(def.dangerous).toBe(true);
      expect(def.controls.reauth.status).toBe('enforced');
      expect(def.controls.reason.status).toBe('enforced');
    }
  });
});
