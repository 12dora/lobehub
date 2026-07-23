// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { users } from '@/database/schemas';
import {
  platformAuditExports,
  platformAuditLogs,
  platformAuditPolicies,
  platformJobs,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { AdminAuditExportService, InMemoryAuditExportArtifactStorage } from './index';

const serverDB: LobeChatDatabase = await getTestDB();
const storage = new InMemoryAuditExportArtifactStorage();
const actor = 'audit-export-svc-actor';
const privileged = 'audit-export-svc-privileged';

const EXPORT_ONLY = ['platform_audit:export:all'] as const;
const EXPORT_AND_CONVERSATION = [
  'platform_audit:export:all',
  'platform_audit:conversation_read:all',
] as const;

const window = {
  from: new Date('2026-03-01T00:00:00.000Z'),
  to: new Date('2026-03-10T00:00:00.000Z'),
};

beforeEach(async () => {
  storage.objects.clear();
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformAuditExports);
  await serverDB.delete(platformJobs);
  await serverDB.delete(platformAuditPolicies);
  await serverDB.delete(users).where(eq(users.id, actor));
  await serverDB.delete(users).where(eq(users.id, privileged));
  await serverDB.insert(users).values([{ id: actor }, { id: privileged }]);
});

afterEach(async () => {
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformAuditExports);
  await serverDB.delete(platformJobs);
  await serverDB.delete(platformAuditPolicies);
});

describe('AdminAuditExportService', () => {
  it('constructs without injected storage and create/list/get work without S3 env', async () => {
    // Production storage is lazy: create/list/get must not instantiate private S3.
    // Injected storage is preserved when provided (other tests cover that path).
    expect(() => new AdminAuditExportService(serverDB)).not.toThrow();

    const service = new AdminAuditExportService(serverDB);
    const created = await service.create({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'create without S3 env',
        to: window.to,
      },
    });
    expect(created).toMatchObject({ kind: 'operation_logs', status: 'pending' });
    expect(created).not.toHaveProperty('storageKey');

    const got = await service.get({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      id: created.id,
    });
    expect(got.id).toBe(created.id);

    const listed = await service.list({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      input: { limit: 10, mine: true },
    });
    expect(listed.items.some((i) => i.id === created.id)).toBe(true);
  });

  it('preserves injected storage for download/cancel', async () => {
    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'injected storage path',
        to: window.to,
      },
    });

    const storageKey = `platform-audit-exports/${created.id}/evidence.ndjson`;
    const body = Buffer.from('{"type":"manifest"}\n');
    storage.objects.set(storageKey, body);
    await serverDB
      .update(platformAuditExports)
      .set({
        artifactBytes: body.byteLength,
        artifactChecksum: 'sha256:abc',
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        status: 'completed',
        storageKey,
      })
      .where(eq(platformAuditExports.id, created.id));

    const dl = await service.download({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      input: { id: created.id, reason: 'use injected storage' },
    });
    expect(dl.downloadUrl).toContain('https://audit-export.test/signed/');
  });

  it('requires conversation read for conversations/user_timeline and userId', async () => {
    const service = new AdminAuditExportService(serverDB, { storage });

    await expect(
      service.create({
        actorPermissions: EXPORT_ONLY,
        actorUserId: actor,
        input: {
          from: window.from,
          includeMessageBodies: false,
          kind: 'conversations',
          reason: 'missing conversation permission',
          to: window.to,
          userId: 'someone',
        },
      }),
    ).rejects.toBeTruthy();

    // Self-audit denial on create
    const deniedLogs = await serverDB
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.audit.exports.create'));
    expect(deniedLogs.some((l) => l.result === 'denied')).toBe(true);

    await expect(
      service.create({
        actorPermissions: EXPORT_AND_CONVERSATION,
        actorUserId: actor,
        input: {
          from: window.from,
          includeMessageBodies: false,
          kind: 'conversations',
          reason: 'ok conversation export',
          to: window.to,
          userId: 'someone',
        },
      }),
    ).resolves.toMatchObject({
      kind: 'conversations',
      status: 'pending',
    });
  });

  it('freezes policyRevision, maxExportRows, exportArtifactRetentionDays in filterSnapshot', async () => {
    await serverDB.insert(platformAuditPolicies).values({
      id: 'global',
      exportArtifactRetentionDays: 14,
      maxExportRows: 1234,
      revision: 7,
    });

    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'freeze policy caps',
        to: window.to,
      },
    });

    expect(created.filterSnapshot).toMatchObject({
      exportArtifactRetentionDays: 14,
      maxExportRows: 1234,
      policyRevision: 7,
    });
    // Public projection must not leak storageKey
    expect(created).not.toHaveProperty('storageKey');
  });

  it('denies includeMessageBodies when policy forbids', async () => {
    await serverDB.insert(platformAuditPolicies).values({
      id: 'global',
      contentAccessMode: 'metadata_only',
      messageBodyInExport: false,
      revision: 0,
    });

    const service = new AdminAuditExportService(serverDB, { storage });
    await expect(
      service.create({
        actorPermissions: EXPORT_AND_CONVERSATION,
        actorUserId: actor,
        input: {
          from: window.from,
          includeMessageBodies: true,
          kind: 'conversations',
          reason: 'bodies not allowed',
          to: window.to,
          userId: 'u1',
        },
      }),
    ).rejects.toBeTruthy();
  });

  it('never returns storageKey on list/get public projection', async () => {
    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'list projection check',
        to: window.to,
      },
    });

    // Force a storage key on the row as if completed
    await serverDB
      .update(platformAuditExports)
      .set({
        artifactChecksum: 'sha256:deadbeef',
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        status: 'completed',
        storageKey: 'platform-audit-exports/secret/key.ndjson',
      })
      .where(eq(platformAuditExports.id, created.id));

    const got = await service.get({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      id: created.id,
    });
    expect(got).not.toHaveProperty('storageKey');
    expect(JSON.stringify(got)).not.toContain('platform-audit-exports/secret');

    const list = await service.list({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      input: { limit: 10, mine: true },
    });
    expect(list.items[0]).not.toHaveProperty('storageKey');
  });

  it('AUDIT_EXPORT-only cannot list/get/download/cancel conversation exports (download bypass regression)', async () => {
    const service = new AdminAuditExportService(serverDB, { storage });

    // Privileged actor creates a completed conversations export with a private artifact.
    const conv = await service.create({
      actorPermissions: EXPORT_AND_CONVERSATION,
      actorUserId: privileged,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'conversations',
        reason: 'privileged conversation export',
        to: window.to,
        userId: 'target-user',
      },
    });

    const storageKey = `platform-audit-exports/${conv.id}/evidence.ndjson`;
    const body = Buffer.from('{"type":"manifest"}\n');
    storage.objects.set(storageKey, body);

    await serverDB
      .update(platformAuditExports)
      .set({
        artifactBytes: body.byteLength,
        artifactChecksum: 'sha256:abc',
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        status: 'completed',
        storageKey,
      })
      .where(eq(platformAuditExports.id, conv.id));

    // Also create an operation_logs export so list is non-empty for export-only.
    const op = await service.create({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'export-only op logs',
        to: window.to,
      },
    });

    // list without kind: only operation_logs (hides privileged conversation export)
    const listed = await service.list({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      input: { limit: 50, mine: false },
    });
    expect(listed.items.every((i) => i.kind === 'operation_logs')).toBe(true);
    expect(listed.items.some((i) => i.id === conv.id)).toBe(false);
    expect(listed.items.some((i) => i.id === op.id)).toBe(true);

    // Explicit conversation kind list must deny + self-audit
    await expect(
      service.list({
        actorPermissions: EXPORT_ONLY,
        actorUserId: actor,
        input: { kind: 'conversations', limit: 10, mine: false },
      }),
    ).rejects.toBeTruthy();

    const listDenied = await serverDB
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.audit.exports.list'));
    expect(listDenied.some((l) => l.result === 'denied')).toBe(true);

    // get / download / cancel must deny (no signed URL, no metadata leak via success)
    await expect(
      service.get({
        actorPermissions: EXPORT_ONLY,
        actorUserId: actor,
        id: conv.id,
      }),
    ).rejects.toBeTruthy();

    await expect(
      service.download({
        actorPermissions: EXPORT_ONLY,
        actorUserId: actor,
        input: { id: conv.id, reason: 'download bypass attempt' },
      }),
    ).rejects.toBeTruthy();

    // Pending conversation for cancel path
    const pendingConv = await service.create({
      actorPermissions: EXPORT_AND_CONVERSATION,
      actorUserId: privileged,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'conversations',
        reason: 'pending for cancel deny',
        to: window.to,
        userId: 'target-user',
      },
    });

    await expect(
      service.cancel({
        actorPermissions: EXPORT_ONLY,
        actorUserId: actor,
        input: { id: pendingConv.id, reason: 'cancel bypass attempt' },
      }),
    ).rejects.toBeTruthy();

    const downloadDenied = await serverDB
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.audit.exports.download'));
    expect(downloadDenied.some((l) => l.result === 'denied')).toBe(true);

    // Privileged actor can still download their conversation export
    const dl = await service.download({
      actorPermissions: EXPORT_AND_CONVERSATION,
      actorUserId: privileged,
      input: { id: conv.id, reason: 'legitimate privileged download' },
    });
    expect(dl.downloadUrl).toContain('https://audit-export.test/signed/');
    expect(dl).not.toHaveProperty('storageKey');
  });
});
