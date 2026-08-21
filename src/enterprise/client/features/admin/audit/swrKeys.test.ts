import { describe, expect, it } from 'vitest';

import { DEFAULT_PAGE_SIZE } from '../primitives/dataTableChange';
import {
  buildAdminAuditConversationMessagesKey,
  buildAdminAuditConversationsListKey,
  buildAdminAuditEventsListKey,
  buildAdminAuditExportsListKey,
  buildAdminAuditHoldsListKey,
  buildAdminAuditRetentionRunsKey,
  buildAdminAuditUserTimelineKey,
} from './swrKeys';

/**
 * Every audit list sends an omitted `limit` as `undefined` and lets the server apply
 * `ADMIN_AUDIT_LIST_DEFAULT_LIMIT`. The key must therefore carry the EFFECTIVE limit: an
 * omitted-limit page shares a cache entry with an explicit default-sized request and with
 * nothing else.
 */
const builders = {
  conversationMessages: (limit?: number) =>
    buildAdminAuditConversationMessagesKey({ limit, topicId: 't1', userId: 'u1' }),
  conversationsList: (limit?: number) =>
    buildAdminAuditConversationsListKey({ limit, userId: 'u1' }),
  eventsList: (limit?: number) => buildAdminAuditEventsListKey({ limit }),
  exportsList: (limit?: number) => buildAdminAuditExportsListKey({ limit }),
  holdsList: (limit?: number) => buildAdminAuditHoldsListKey({ limit }),
  retentionRuns: (limit?: number) => buildAdminAuditRetentionRunsKey({ limit }),
  userTimeline: (limit?: number) => buildAdminAuditUserTimelineKey({ limit, userId: 'u1' }),
} as const;

describe('admin Audit SWR keys', () => {
  describe.each(Object.entries(builders))('%s', (_name, build) => {
    it('maps an omitted limit onto the shared default size', () => {
      expect(build()).toEqual(build(DEFAULT_PAGE_SIZE));
    });

    it('does not share a key with a differently sized request', () => {
      expect(build()).not.toEqual(build(DEFAULT_PAGE_SIZE + 30));
      expect(build(50)).not.toEqual(build(100));
    });

    it('puts the effective limit last in the key', () => {
      expect(build(50).at(-1)).toBe(50);
      expect(build().at(-1)).toBe(DEFAULT_PAGE_SIZE);
    });
  });

  it('still separates lists by their own filter dimensions', () => {
    expect(buildAdminAuditEventsListKey({ limit: 50, result: 'denied' })).not.toEqual(
      buildAdminAuditEventsListKey({ limit: 50, result: 'success' }),
    );
    expect(buildAdminAuditHoldsListKey({ cursor: 'older', limit: 50 })).not.toEqual(
      buildAdminAuditHoldsListKey({ limit: 50 }),
    );
  });
});
