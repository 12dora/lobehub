// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { containsSensitiveMaterial } from '@/database/models/platform';
import { platformAuditLogs } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { PlatformAuditService } from '../platformAudit';

const serverDB: LobeChatDatabase = await getTestDB();
const audit = new PlatformAuditService(serverDB);

afterEach(async () => {
  // Suite only writes as admin-1 — scope so TEST_SERVER_DB=1 does not wipe peers (SG-07).
  await deletePlatformAuditLogsForTest(serverDB, { actorUserIds: ['admin-1'] });
});

describe('PlatformAuditService', () => {
  it('redacts secrets from audit diffs before persistence', async () => {
    const row = await audit.append({
      action: 'platform.provider.publish',
      actorUserId: 'admin-1',
      afterDiff: {
        apiKey: 'sk-fake-service-key-not-real',
        clientSecret: 'fake-client-secret',
        name: 'openai',
        nested: { Authorization: 'Bearer fake-token', token: 'fake-oauth-token' },
      },
      beforeDiff: { token: 'old-fake-token' },
      reason: 'rotate',
      requestId: 'req-svc-1',
      result: 'success',
      targetId: 'prov_1',
      targetType: 'provider',
    });

    expect(containsSensitiveMaterial(row.beforeDiff)).toBe(false);
    expect(containsSensitiveMaterial(row.afterDiff)).toBe(false);
    expect(JSON.stringify(row)).not.toMatch(
      /sk-fake-service-key|fake-client-secret|Bearer fake|old-fake-token/i,
    );
    expect(row.afterDiff).toMatchObject({
      apiKey: '[REDACTED]',
      clientSecret: '[REDACTED]',
      name: 'openai',
    });
  });

  it('supports cursor pagination without unbounded export', async () => {
    await audit.append({
      action: 'platform.settings.publish',
      result: 'success',
      targetType: 'settings',
    });
    await audit.append({
      action: 'platform.roles.replace',
      result: 'success',
      targetType: 'settings',
    });

    const page = await audit.list({ limit: 1, targetType: 'settings' });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
  });

  it('redacts legacy fingerprint fields recursively from list and detail reads', async () => {
    const secretFingerprint = 'a'.repeat(64);
    await serverDB.insert(platformAuditLogs).values({
      action: 'admin.identityProviders.publish',
      afterDiff: {
        response: {
          fingerprint: secretFingerprint,
          nested: [{ secretFingerprint }],
          providerKey: 'work',
        },
        secretFingerprint,
      },
      beforeDiff: { previousFingerprint: secretFingerprint },
      id: 'legacy-identity-provider-audit',
      result: 'success',
      targetId: 'provider-work',
      targetType: 'identity_provider',
    });

    const detail = await audit.findById('legacy-identity-provider-audit');
    const page = await audit.list({ targetId: 'provider-work' });

    for (const output of [detail, page.items[0]]) {
      const serialized = JSON.stringify(output);
      expect(serialized).not.toContain(secretFingerprint);
      expect(serialized).not.toMatch(/fingerprint/i);
      expect(output?.afterDiff).toMatchObject({ response: { providerKey: 'work' } });
    }
  });
});
