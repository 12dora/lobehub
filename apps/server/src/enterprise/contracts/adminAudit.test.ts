// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  ADMIN_AUDIT_LIST_MAX_LIMIT,
  adminAuditConversationsGetOutputSchema,
  adminAuditConversationsListInputSchema,
  adminAuditConversationsListOutputSchema,
  adminAuditConversationsMessagesOutputSchema,
  adminAuditEventsListInputSchema,
  adminAuditExportItemSchema,
  adminAuditExportsCreateInputSchema,
  adminAuditLegalHoldsCreateInputSchema,
  adminAuditLegalHoldsListInputSchema,
  adminAuditPolicyUpdateInputSchema,
  adminAuditRetentionRunItemSchema,
  adminAuditUsersSearchInputSchema,
  adminAuditUsersTimelineOutputSchema,
  dateInputSchema,
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

  it('accepts redactionProfile off and rejects unknown profiles', () => {
    const ok = adminAuditPolicyUpdateInputSchema.parse({
      expectedRevision: 0,
      reason: 'disable conversation credential masking for incident review',
      redactionProfile: 'off',
    });
    expect(ok.redactionProfile).toBe('off');

    expect(() =>
      adminAuditPolicyUpdateInputSchema.parse({
        expectedRevision: 0,
        reason: 'invalid redaction profile',
        redactionProfile: 'loose',
      }),
    ).toThrow();
  });

  it('conversation and timeline envelopes require a known redactionProfile', () => {
    const now = new Date();
    const listItem = {
      agentId: null,
      createdAt: now,
      description: null,
      id: 't1',
      model: null,
      provider: null,
      sessionId: null,
      status: null,
      title: 'memo',
      updatedAt: now,
      userId: 'u1',
    };

    expect(
      adminAuditConversationsListOutputSchema.safeParse({ items: [], nextCursor: null }).success,
    ).toBe(false);
    expect(
      adminAuditConversationsListOutputSchema.parse({
        items: [listItem],
        nextCursor: null,
        redactionProfile: 'off',
      }).redactionProfile,
    ).toBe('off');
    expect(
      adminAuditConversationsListOutputSchema.safeParse({
        items: [],
        nextCursor: null,
        redactionProfile: 'loose',
      }).success,
    ).toBe(false);

    expect(
      adminAuditConversationsGetOutputSchema.parse({
        ...listItem,
        contentAccessMode: 'content_allowed',
        redactionProfile: 'strict',
      }).redactionProfile,
    ).toBe('strict');

    expect(
      adminAuditConversationsMessagesOutputSchema.parse({
        contentAccessMode: 'content_allowed',
        items: [],
        nextCursor: null,
        redactionProfile: 'standard',
      }).redactionProfile,
    ).toBe('standard');

    expect(
      adminAuditUsersTimelineOutputSchema.parse({
        items: [],
        nextCursor: null,
        redactionProfile: 'off',
      }).redactionProfile,
    ).toBe('off');
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

  it('export/retention error DTOs accept only bounded codes and reject raw messages', () => {
    const exportBase = {
      artifactBytes: null,
      artifactChecksum: null,
      createdAt: new Date(),
      error: { code: 'EXPORT_FAILED' as const },
      expiresAt: null,
      filterSnapshot: {},
      finishedAt: new Date(),
      id: 'paex_err',
      includesMessageBodies: false,
      jobId: null,
      kind: 'operation_logs' as const,
      requestedBy: 'admin',
      rowCount: null,
      startedAt: new Date(),
      status: 'failed' as const,
      updatedAt: new Date(),
    };
    expect(adminAuditExportItemSchema.parse(exportBase).error).toEqual({ code: 'EXPORT_FAILED' });
    // Free-form messages and storage-key leakage must not pass the public DTO.
    expect(
      adminAuditExportItemSchema.safeParse({
        ...exportBase,
        error: {
          code: 'EXPORT_FAILED',
          message: 'S3 key platform-audit-exports/secret/evidence.ndjson missing',
        },
      }).success,
    ).toBe(false);
    expect(
      adminAuditExportItemSchema.safeParse({
        ...exportBase,
        error: { code: 'Error' },
      }).success,
    ).toBe(false);

    const retentionBase = {
      counts: {},
      createdAt: new Date(),
      cutoffAt: new Date(),
      error: { code: 'RETENTION_FAILED' as const },
      finishedAt: new Date(),
      id: 'parr_err',
      jobId: null,
      mode: 'execute' as const,
      policyRevision: 1,
      progressDone: 0,
      progressTotal: null,
      requestedBy: 'admin',
      scope: 'operation_logs' as const,
      startedAt: new Date(),
      status: 'failed' as const,
      updatedAt: new Date(),
    };
    expect(adminAuditRetentionRunItemSchema.parse(retentionBase).error).toEqual({
      code: 'RETENTION_FAILED',
    });
    expect(
      adminAuditRetentionRunItemSchema.safeParse({
        ...retentionBase,
        error: {
          code: 'RETENTION_FAILED',
          message: 'relation "platform_audit_exports" does not exist',
        },
      }).success,
    ).toBe(false);
  });

  it('rejects boolean/null/number/string date coercion traps', () => {
    for (const bad of [null, false, true, 0, 1, '2026-01-01T00:00:00.000Z'] as const) {
      expect(dateInputSchema.safeParse(bad).success).toBe(false);
    }
    const when = new Date('2026-01-01T00:00:00.000Z');
    expect(dateInputSchema.parse(when)).toEqual(when);
  });

  it('validates legal-hold scopeType/scopeId pairs for list and create', () => {
    const reason = 'Preserve evidence for litigation hold';

    // Create matrix
    expect(
      adminAuditLegalHoldsCreateInputSchema.safeParse({
        reason,
        scopeType: 'global',
      }).success,
    ).toBe(true);
    expect(
      adminAuditLegalHoldsCreateInputSchema.parse({
        reason,
        scopeId: null,
        scopeType: 'global',
      }).scopeId,
    ).toBeNull();
    expect(
      adminAuditLegalHoldsCreateInputSchema.safeParse({
        reason,
        scopeId: 'unexpected',
        scopeType: 'global',
      }).success,
    ).toBe(false);

    for (const scopeType of ['user', 'session', 'topic', 'workspace'] as const) {
      expect(
        adminAuditLegalHoldsCreateInputSchema.safeParse({
          reason,
          scopeId: 'scope-1',
          scopeType,
        }).success,
      ).toBe(true);
      expect(
        adminAuditLegalHoldsCreateInputSchema.safeParse({
          reason,
          scopeId: null,
          scopeType,
        }).success,
      ).toBe(false);
      expect(
        adminAuditLegalHoldsCreateInputSchema.safeParse({
          reason,
          scopeType,
        }).success,
      ).toBe(false);
    }

    // List filter matrix
    expect(adminAuditLegalHoldsListInputSchema.safeParse({ scopeType: 'global' }).success).toBe(
      true,
    );
    expect(
      adminAuditLegalHoldsListInputSchema.safeParse({
        scopeId: 'unexpected',
        scopeType: 'global',
      }).success,
    ).toBe(false);
    // Type-only filter (scopeType without scopeId) is valid for list; UI sends this.
    // Explicit null remains a contradictory pair and must still fail.
    expect(adminAuditLegalHoldsListInputSchema.safeParse({ scopeType: 'user' }).success).toBe(true);
    expect(
      adminAuditLegalHoldsListInputSchema.safeParse({ scopeId: null, scopeType: 'user' }).success,
    ).toBe(false);
    expect(
      adminAuditLegalHoldsListInputSchema.safeParse({
        scopeId: 'user-1',
        scopeType: 'user',
      }).success,
    ).toBe(true);
  });
});
