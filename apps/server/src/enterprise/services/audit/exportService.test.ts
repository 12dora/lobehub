// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { getTestDB } from '@/database/core/getTestDB';
import { users } from '@/database/schemas';
import {
  platformAuditExports,
  platformAuditLogs,
  platformAuditPolicies,
  platformJobs,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import * as accessLog from './accessLog';
import {
  AdminAuditExportService,
  formatArtifactChecksum,
  InMemoryAuditExportArtifactStorage,
  sha256Hex,
} from './index';

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

/** Test cleanup: bypass append-only trigger on platform_audit_logs. */
const clearAuditLogs = async () => {
  await serverDB.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
    await tx.delete(platformAuditLogs);
  });
};

beforeEach(async () => {
  storage.objects.clear();
  await clearAuditLogs();
  await serverDB.delete(platformAuditExports);
  await serverDB.delete(platformJobs);
  await serverDB.delete(platformAuditPolicies);
  await serverDB.delete(users).where(eq(users.id, actor));
  await serverDB.delete(users).where(eq(users.id, privileged));
  await serverDB.insert(users).values([{ id: actor }, { id: privileged }]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await clearAuditLogs();
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
    const checksum = formatArtifactChecksum(sha256Hex(body));
    await serverDB
      .update(platformAuditExports)
      .set({
        artifactBytes: body.byteLength,
        artifactChecksum: checksum,
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
    expect(dl.artifactChecksum).toBe(checksum);
  });

  it('rolls back export + job when create path fails inside the publication TX', async () => {
    const service = new AdminAuditExportService(serverDB, {
      afterCreateExport: async () => {
        throw new Error('INJECTED_ENQUEUE_PATH_FAILURE');
      },
      storage,
    });

    await expect(
      service.create({
        actorPermissions: EXPORT_ONLY,
        actorUserId: actor,
        input: {
          from: window.from,
          includeMessageBodies: false,
          kind: 'operation_logs',
          reason: 'enqueue fail orphan guard',
          to: window.to,
        },
      }),
    ).rejects.toBeTruthy();

    // Atomic create+enqueue+audit: failure leaves no claimable job or export row.
    const rows = await serverDB.select().from(platformAuditExports);
    expect(rows).toHaveLength(0);

    const jobs = await serverDB.select().from(platformJobs);
    expect(jobs).toHaveLength(0);
  });

  it('rolls back export + job when link fails after enqueue inside the publication TX', async () => {
    const service = new AdminAuditExportService(serverDB, {
      afterEnqueue: async () => {
        throw new Error('INJECTED_LINK_FAILURE');
      },
      storage,
    });

    await expect(
      service.create({
        actorPermissions: EXPORT_ONLY,
        actorUserId: actor,
        input: {
          from: window.from,
          includeMessageBodies: false,
          kind: 'operation_logs',
          reason: 'link fail orphan guard',
          to: window.to,
        },
      }),
    ).rejects.toBeTruthy();

    const rows = await serverDB.select().from(platformAuditExports);
    expect(rows).toHaveLength(0);

    const jobs = await serverDB.select().from(platformJobs);
    expect(jobs).toHaveLength(0);
  });

  it('F1: required-audit failure leaves no claimable job for concurrent workers', async () => {
    // Single-connection harness cannot open a second TX while create holds the
    // publication lock; instead prove the same isolation invariant: if the
    // required audit path aborts after enqueue, claimNext never observes a job.
    const { PlatformJobModel } = await import('@/database/models/platform');
    const { PLATFORM_AUDIT_EXPORT_JOB_TYPE } = await import('./exportConstants');

    const service = new AdminAuditExportService(serverDB, {
      afterEnqueue: async () => {
        throw new Error('INJECTED_AUDIT_GATE_FAILURE');
      },
      storage,
    });

    await expect(
      service.create({
        actorPermissions: EXPORT_ONLY,
        actorUserId: actor,
        input: {
          from: window.from,
          includeMessageBodies: false,
          kind: 'operation_logs',
          reason: 'concurrent claim guard',
          to: window.to,
        },
      }),
    ).rejects.toBeTruthy();

    const jobsModel = new PlatformJobModel(serverDB);
    const claimed = await jobsModel.claimNext({
      leaseMs: 60_000,
      types: [PLATFORM_AUDIT_EXPORT_JOB_TYPE],
      workerId: 'f1-claim-worker',
    });
    expect(claimed).toBeNull();
    expect(await serverDB.select().from(platformJobs)).toHaveLength(0);
  });

  it('F12: same client idempotencyKey create returns the same export+job (no second row)', async () => {
    const service = new AdminAuditExportService(serverDB, { storage });
    const input = {
      from: window.from,
      includeMessageBodies: false,
      kind: 'operation_logs' as const,
      reason: 'f12 sequential same-key create',
      to: window.to,
    };
    const first = await service.create({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      idempotencyKey: 'f12-sequential-key',
      input,
    });
    const second = await service.create({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      idempotencyKey: 'f12-sequential-key',
      input,
    });

    expect(second.id).toBe(first.id);
    expect(second.jobId).toBe(first.jobId);
    expect(await serverDB.select().from(platformAuditExports)).toHaveLength(1);
    expect(await serverDB.select().from(platformJobs)).toHaveLength(1);
  });

  it('F5: cancel returns code-only public error (no purge outbox fields)', async () => {
    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'cancel projection',
        to: window.to,
      },
    });

    const cancelled = await service.cancel({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      input: { id: created.id, reason: 'operator cancel' },
    });

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled).not.toHaveProperty('storageKey');
    // Strict DTO: error is null or { code } only — never message/purgeStorageKey.
    if (cancelled.error != null) {
      expect(Object.keys(cancelled.error).sort()).toEqual(['code']);
      expect(typeof cancelled.error.code).toBe('string');
    }
    expect(JSON.stringify(cancelled)).not.toContain('purgeStorageKey');
    expect(JSON.stringify(cancelled)).not.toContain('platform-audit-exports/');
  });

  it('pre-TX already-terminal cancel writes already_terminal failure audit', async () => {
    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'already terminal',
        to: window.to,
      },
    });

    await serverDB
      .update(platformAuditExports)
      .set({
        artifactBytes: 1,
        artifactChecksum: formatArtifactChecksum(sha256Hex(Buffer.from('x'))),
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        status: 'completed',
        storageKey: `platform-audit-exports/${created.id}/evidence.ndjson`,
      })
      .where(eq(platformAuditExports.id, created.id));

    let thrown: unknown;
    try {
      await service.cancel({
        actorPermissions: EXPORT_ONLY,
        actorUserId: actor,
        input: { id: created.id, reason: 'stale cancel' },
      });
    } catch (error) {
      thrown = error;
    }

    expect(getEnterpriseErrorBody(thrown)).toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { reason: 'export_already_terminal', status: 'completed' },
    });

    const cancelLogs = await serverDB
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.audit.exports.cancel'));
    const alreadyTerminal = cancelLogs.filter(
      (row) =>
        row.result === 'failure' &&
        (row.afterDiff as { error?: string } | null)?.error === 'already_terminal',
    );
    expect(alreadyTerminal).toHaveLength(1);
  });

  it('conflict cancel required-audit append failure is recorded via the cancel catch path', async () => {
    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'conflict catch audit',
        to: window.to,
      },
    });

    const originalAppend = accessLog.appendAuditAccessLog;
    vi.spyOn(accessLog, 'appendAuditAccessLog').mockImplementation(async (db, params) => {
      if (
        params.required &&
        params.action === 'admin.audit.exports.cancel' &&
        (params.afterDiff as { error?: string } | undefined)?.error === 'already_terminal'
      ) {
        throw new Error('INJECTED_AUDIT_WRITE_FAILURE');
      }
      return originalAppend(db, params);
    });

    await expect(
      service.cancel({
        actorPermissions: EXPORT_ONLY,
        actorUserId: actor,
        beforeCancelTx: async ({ exportId }) => {
          await serverDB
            .update(platformAuditExports)
            .set({
              artifactBytes: 1,
              artifactChecksum: formatArtifactChecksum(sha256Hex(Buffer.from('x'))),
              expiresAt: new Date('2026-12-01T00:00:00.000Z'),
              status: 'completed',
              storageKey: `platform-audit-exports/${exportId}/evidence.ndjson`,
            })
            .where(eq(platformAuditExports.id, exportId));
        },
        input: { id: created.id, reason: 'stale cancel race' },
      }),
    ).rejects.toThrow(/INJECTED_AUDIT_WRITE_FAILURE/);

    // Outer catch must still write the generic failure audit (return-await of the helper).
    const cancelLogs = await serverDB
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.audit.exports.cancel'));
    expect(
      cancelLogs.some(
        (row) =>
          row.result === 'failure' &&
          (row.afterDiff as { error?: string } | null)?.error === 'failure',
      ),
    ).toBe(true);
  });

  it('rejects download when object is same-length but checksum-corrupted', async () => {
    const service = new AdminAuditExportService(serverDB, { storage });
    const created = await service.create({
      actorPermissions: EXPORT_ONLY,
      actorUserId: actor,
      input: {
        from: window.from,
        includeMessageBodies: false,
        kind: 'operation_logs',
        reason: 'checksum integrity',
        to: window.to,
      },
    });

    const storageKey = `platform-audit-exports/${created.id}/evidence.ndjson`;
    const original = Buffer.from('{"type":"manifest"}\n');
    const corrupted = Buffer.from('{"type":"MANIFEST"}\n'); // same length, different content
    expect(corrupted.byteLength).toBe(original.byteLength);
    storage.objects.set(storageKey, corrupted);

    await serverDB
      .update(platformAuditExports)
      .set({
        artifactBytes: original.byteLength,
        artifactChecksum: formatArtifactChecksum(sha256Hex(original)),
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        status: 'completed',
        storageKey,
      })
      .where(eq(platformAuditExports.id, created.id));

    await expect(
      service.download({
        actorPermissions: EXPORT_ONLY,
        actorUserId: actor,
        input: { id: created.id, reason: 'corrupted download' },
      }),
    ).rejects.toBeTruthy();

    const logs = await serverDB
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.action, 'admin.audit.exports.download'));
    expect(logs.some((l) => l.result === 'failure')).toBe(true);
    // No success audit for corrupted artifact
    expect(logs.some((l) => l.result === 'success')).toBe(false);
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
        artifactChecksum: formatArtifactChecksum(sha256Hex(body)),
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
