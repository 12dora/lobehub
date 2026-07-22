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

  it('filters by actor/action/result/time and isolates actors', async () => {
    const tEarly = new Date('2026-06-01T00:00:00.000Z');
    const tMid = new Date('2026-07-01T00:00:00.000Z');
    const tLate = new Date('2026-08-01T00:00:00.000Z');

    await serverDB.insert(platformAuditLogs).values([
      {
        action: 'platform.settings.publish',
        actorUserId: 'admin-1',
        createdAt: tEarly,
        id: 'paud_filter_early',
        result: 'success',
        targetType: 'settings',
      },
      {
        action: 'platform.settings.publish',
        actorUserId: 'admin-1',
        createdAt: tMid,
        id: 'paud_filter_mid',
        result: 'failure',
        targetType: 'settings',
      },
      {
        action: 'platform.branding.publish',
        actorUserId: 'admin-2',
        createdAt: tLate,
        id: 'paud_filter_late',
        result: 'denied',
        targetType: 'branding',
      },
    ]);

    const byActor = await auditModel.list({ actorUserId: 'admin-1' });
    expect(byActor.items.map((r) => r.id).toSorted()).toEqual([
      'paud_filter_early',
      'paud_filter_mid',
    ]);
    expect(byActor.items.every((r) => r.actorUserId === 'admin-1')).toBe(true);

    const byAction = await auditModel.list({ action: 'platform.branding.publish' });
    expect(byAction.items.map((r) => r.id)).toEqual(['paud_filter_late']);

    const byResult = await auditModel.list({ result: 'failure' });
    expect(byResult.items.map((r) => r.id)).toEqual(['paud_filter_mid']);

    const byWindow = await auditModel.list({
      from: new Date('2026-06-15T00:00:00.000Z'),
      to: new Date('2026-07-15T00:00:00.000Z'),
    });
    expect(byWindow.items.map((r) => r.id)).toEqual(['paud_filter_mid']);

    const multi = await auditModel.list({
      actions: ['platform.settings.publish'],
      results: ['success', 'failure'],
    });
    expect(multi.items.map((r) => r.id).toSorted()).toEqual([
      'paud_filter_early',
      'paud_filter_mid',
    ]);
  });

  it('returns bounded facets and stats over a time window', async () => {
    await serverDB.insert(platformAuditLogs).values([
      {
        action: 'a.publish',
        actorUserId: 'admin-1',
        id: 'paud_facet_1',
        result: 'success',
        targetType: 'settings',
      },
      {
        action: 'a.publish',
        actorUserId: 'admin-1',
        id: 'paud_facet_2',
        result: 'success',
        targetType: 'settings',
      },
      {
        action: 'b.rollback',
        actorUserId: 'admin-2',
        id: 'paud_facet_3',
        result: 'failure',
        targetType: 'settings',
      },
      {
        action: 'c.denied',
        actorUserId: 'admin-2',
        id: 'paud_facet_4',
        result: 'denied',
        targetType: 'settings',
      },
    ]);

    const facets = await auditModel.getFacets({ limit: 10 });
    expect(facets.actions.find((b) => b.value === 'a.publish')?.count).toBe(2);
    expect(facets.results.find((b) => b.value === 'success')?.count).toBe(2);
    expect(facets.actions.length).toBeLessThanOrEqual(10);

    const stats = await auditModel.getStats();
    expect(stats).toEqual({ denied: 1, failure: 1, success: 2, total: 4 });
  });
});
