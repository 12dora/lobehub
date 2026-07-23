// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  ADMIN_AUDIT_LIST_MAX_LIMIT,
  adminAuditConversationsListInputSchema,
  adminAuditEventsListInputSchema,
  adminAuditExportItemSchema,
  adminAuditExportsCreateInputSchema,
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

  it('export create requires userId for conversation kinds and rejects cross-kind filters', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-01-10T00:00:00.000Z');

    expect(() =>
      adminAuditExportsCreateInputSchema.parse({
        from,
        kind: 'conversations',
        reason: 'missing user',
        to,
      }),
    ).toThrow(/userId/i);

    expect(() =>
      adminAuditExportsCreateInputSchema.parse({
        from,
        kind: 'operation_logs',
        q: 'title',
        reason: 'q only for conversations',
        to,
      }),
    ).toThrow();

    const ok = adminAuditExportsCreateInputSchema.parse({
      from,
      includeMessageBodies: true,
      kind: 'conversations',
      q: '  memo  ',
      reason: 'export conversations',
      to,
      userId: 'user-1',
    });
    expect(ok.userId).toBe('user-1');
    expect(ok.q).toBe('memo');
    expect(ok.includeMessageBodies).toBe(true);
  });

  it('export public item schema rejects storageKey and accepts frozen policy caps', () => {
    const base = {
      artifactBytes: 10,
      artifactChecksum: 'sha256:abc',
      createdAt: new Date(),
      error: null,
      expiresAt: new Date(),
      filterSnapshot: {
        exportArtifactRetentionDays: 7,
        from: '2026-01-01T00:00:00.000Z',
        maxExportRows: 50_000,
        policyRevision: 3,
        to: '2026-01-10T00:00:00.000Z',
      },
      finishedAt: new Date(),
      id: 'paex_1',
      includesMessageBodies: false,
      jobId: null,
      kind: 'operation_logs' as const,
      requestedBy: 'admin',
      rowCount: 1,
      startedAt: new Date(),
      status: 'completed' as const,
      updatedAt: new Date(),
    };
    const parsed = adminAuditExportItemSchema.parse(base);
    expect(parsed).toMatchObject({ id: 'paex_1' });
    expect(parsed.filterSnapshot).toMatchObject({
      exportArtifactRetentionDays: 7,
      maxExportRows: 50_000,
      policyRevision: 3,
    });
    expect(() =>
      adminAuditExportItemSchema.parse({
        ...base,
        storageKey: 'platform-audit-exports/x/evidence.ndjson',
      }),
    ).toThrow();
  });
});
