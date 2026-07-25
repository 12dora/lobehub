// @vitest-environment node
/**
 * Risk-control inventory for A3 export mutations.
 * Permission/kind facts are owned by adminProcedureAuthorizationRegistry reconciliation.
 */
import { describe, expect, it } from 'vitest';

import { ADMIN_MUTATION_REGISTRY } from './adminMutationRegistry';

const EXPORT_MUTATIONS = [
  'admin.audit.exports.cancel',
  'admin.audit.exports.create',
  'admin.audit.exports.download',
] as const;

describe('admin.audit.exports risk inventory', () => {
  it('keeps export mutations high-risk with enforced reauth and reason', () => {
    for (const path of EXPORT_MUTATIONS) {
      const def = ADMIN_MUTATION_REGISTRY[path];
      expect(def.risk).toBe('high');
      expect(def.dangerous).toBe(true);
      expect(def.controls.reauth.status).toBe('enforced');
      expect(def.controls.reason.status).toBe('enforced');
    }
  });
});
