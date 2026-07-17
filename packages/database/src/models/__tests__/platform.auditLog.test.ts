// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformAuditLogs } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { containsSensitiveMaterial, PlatformAuditLogModel } from '../platform';

const serverDB: LobeChatDatabase = await getTestDB();
const auditModel = new PlatformAuditLogModel(serverDB);

afterEach(async () => {
  await serverDB.delete(platformAuditLogs);
});

describe('PlatformAuditLogModel', () => {
  it('appends a caller-keyed audit exactly once across delivery retries', async () => {
    const params = {
      action: 'connector.runtime.sharedCall',
      actorUserId: 'user-1',
      id: `connector-runtime-audit:${crypto.randomUUID()}`,
      result: 'success' as const,
      targetId: 'connector-1',
      targetType: 'connector',
    };

    const first = await auditModel.append(params);
    const replay = await auditModel.append(params);

    expect(replay.id).toBe(first.id);
    await expect(serverDB.query.platformAuditLogs.findMany()).resolves.toHaveLength(1);
  });

  it('appends redacted audit rows and supports cursor pagination', async () => {
    const first = await auditModel.append({
      action: 'platform.branding.publish',
      actorUserId: 'admin-1',
      afterDiff: {
        apiKey: 'sk-fake-audit-key-not-real',
        clientSecret: 'fake-client-secret',
        displayName: 'AIHub',
      },
      beforeDiff: {
        Authorization: 'Bearer fake-header-token',
        token: 'fake-token',
      },
      reason: 'test',
      requestId: 'req-audit-1',
      result: 'success',
      targetId: 'branding-1',
      targetType: 'branding',
    });

    expect(first.id).toMatch(/^paud_/);
    expect(containsSensitiveMaterial(first.beforeDiff)).toBe(false);
    expect(containsSensitiveMaterial(first.afterDiff)).toBe(false);
    expect(JSON.stringify(first)).not.toMatch(/sk-fake-audit-key|fake-client-secret|Bearer fake/i);

    await auditModel.append({
      action: 'platform.branding.publish',
      actorUserId: 'admin-1',
      result: 'success',
      targetId: 'branding-1',
      targetType: 'branding',
    });

    const page = await auditModel.list({ limit: 1, targetType: 'branding' });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    // Composite cursor is `${iso}|${id}` — pass the string through (not new Date(...)).
    expect(page.nextCursor).toContain('|');

    const page2 = await auditModel.list({
      cursor: page.nextCursor!,
      limit: 10,
      targetType: 'branding',
    });
    expect(page2.items.length).toBeGreaterThanOrEqual(1);

    // Legacy bare-ISO / valid Date still accepted as cursor input.
    const page3 = await auditModel.list({
      cursor: page.items[0]!.createdAt,
      limit: 10,
      targetType: 'branding',
    });
    expect(page3.items).toEqual(expect.any(Array));
  });

  it('does not expose an update or delete surface (append-only contract)', () => {
    const model = new PlatformAuditLogModel(serverDB);
    expect(typeof model.append).toBe('function');
    expect(typeof model.list).toBe('function');
    expect(typeof model.findById).toBe('function');
    expect((model as { update?: unknown }).update).toBeUndefined();
    expect((model as { delete?: unknown }).delete).toBeUndefined();
  });

  it('redacts camelCase token fields before they land in the audit table', async () => {
    const row = await auditModel.append({
      action: 'platform.connector.bind',
      afterDiff: {
        accessToken: 'opaque-access-token-for-m09-oauth',
        apiToken: 'opaque-api-token',
        authorizationHeader: 'opaque-auth-header',
        awsSecretAccessKey: '[REDACTED]',
        idToken: 'opaque-id-token-for-oidc',
        openaiApiKey: '[REDACTED]',
        sessionToken: 'opaque-session-token',
        status: 'connected',
        xApiKey: 'opaque-x-api-key',
      },
      result: 'success',
      targetId: 'binding_1',
      targetType: 'connector',
    });

    expect(row.afterDiff).toMatchObject({
      accessToken: '[REDACTED]',
      apiToken: '[REDACTED]',
      authorizationHeader: '[REDACTED]',
      awsSecretAccessKey: '[REDACTED]',
      idToken: '[REDACTED]',
      openaiApiKey: '[REDACTED]',
      sessionToken: '[REDACTED]',
      status: 'connected',
      xApiKey: '[REDACTED]',
    });
    expect(containsSensitiveMaterial(row.afterDiff)).toBe(false);
    expect(JSON.stringify(row.afterDiff)).not.toMatch(/opaque-/i);

    const stored = await auditModel.findById(row.id);
    expect(JSON.stringify(stored)).not.toMatch(/opaque-/i);
  });
});
