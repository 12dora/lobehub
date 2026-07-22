// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  ADMIN_AUDIT_LIST_MAX_LIMIT,
  adminAuditConversationsListInputSchema,
  adminAuditEventsListInputSchema,
  adminAuditPolicyUpdateInputSchema,
  adminAuditUsersSearchInputSchema,
} from './adminAudit';

describe('adminAudit contracts', () => {
  it('clamps list limit to max 200 and defaults limit', () => {
    const parsed = adminAuditEventsListInputSchema.parse({});
    expect(parsed.limit).toBe(50);
    expect(() => adminAuditEventsListInputSchema.parse({ limit: 201 })).toThrow();
    expect(adminAuditEventsListInputSchema.parse({ limit: ADMIN_AUDIT_LIST_MAX_LIMIT }).limit).toBe(
      200,
    );
  });

  it('requires userId for conversations and accepts title-only q', () => {
    expect(() => adminAuditConversationsListInputSchema.parse({})).toThrow();
    const ok = adminAuditConversationsListInputSchema.parse({
      q: '  title  ',
      userId: 'user-1',
    });
    expect(ok.userId).toBe('user-1');
    expect(ok.q).toBe('title');
  });

  it('rejects credential material in policy update reason', () => {
    expect(() =>
      adminAuditPolicyUpdateInputSchema.parse({
        expectedRevision: 0,
        reason: 'rotate Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345',
      }),
    ).toThrow(/credential/i);
    const ok = adminAuditPolicyUpdateInputSchema.parse({
      expectedRevision: 0,
      maxListWindowDays: 30,
      reason: 'Tighten list window for SOC review',
    });
    expect(ok.maxListWindowDays).toBe(30);
  });

  it('normalizes user search q and never allows empty', () => {
    expect(() => adminAuditUsersSearchInputSchema.parse({ q: '   ' })).toThrow();
    const ok = adminAuditUsersSearchInputSchema.parse({ q: '  Alice@Example.COM  ' });
    expect(ok.q).toBe('alice@example.com');
  });
});
