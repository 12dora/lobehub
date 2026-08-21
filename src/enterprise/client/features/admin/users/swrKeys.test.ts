import { describe, expect, it } from 'vitest';

import { DEFAULT_PAGE_SIZE } from '../primitives/dataTableChange';
import { buildAdminUsersAuditKey, buildAdminUsersListKey } from './swrKeys';

describe('admin Users SWR keys', () => {
  describe('cache identity for an omitted limit', () => {
    // An omitted `limit` is sent as `undefined` and the server fills in its own default, so the
    // key must normalize to that same effective size — otherwise a default-sized page and a
    // differently sized explicit page collide on one cache entry.
    it('matches an explicit request for the shared default size (audit trail)', () => {
      expect(buildAdminUsersAuditKey({ userId: 'u1' })).toEqual(
        buildAdminUsersAuditKey({ limit: DEFAULT_PAGE_SIZE, userId: 'u1' }),
      );
    });

    it('differs from an explicit request of another size (audit trail)', () => {
      expect(buildAdminUsersAuditKey({ userId: 'u1' })).not.toEqual(
        buildAdminUsersAuditKey({ limit: DEFAULT_PAGE_SIZE + 30, userId: 'u1' }),
      );
    });

    it('matches an explicit request for the shared default size (list)', () => {
      expect(buildAdminUsersListKey({ query: 'alice' })).toEqual(
        buildAdminUsersListKey({ limit: DEFAULT_PAGE_SIZE, query: 'alice' }),
      );
    });

    it('differs from an explicit request of another size (list)', () => {
      expect(buildAdminUsersListKey({ query: 'alice' })).not.toEqual(
        buildAdminUsersListKey({ limit: DEFAULT_PAGE_SIZE + 30, query: 'alice' }),
      );
    });
  });

  it('separates pages of the same user audit trail by cursor', () => {
    expect(buildAdminUsersAuditKey({ cursor: 'older', limit: 50, userId: 'u1' })).toEqual([
      'admin.users.getAuditTrail',
      'u1',
      'older',
      50,
    ]);
    expect(buildAdminUsersAuditKey({ cursor: 'older', limit: 50, userId: 'u1' })).not.toEqual(
      buildAdminUsersAuditKey({ limit: 50, userId: 'u1' }),
    );
  });
});
