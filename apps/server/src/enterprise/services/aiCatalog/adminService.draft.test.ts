// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformRevisionConflictError } from '@/database/models/platform';
import {
  platformAiModels,
  platformAiProviders,
  platformAiProviderSecrets,
  platformAuditLogs,
  platformResourceRevisions,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { AiCatalogAdminService } from './adminService';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(23), keyId: 'draft-test' }),
  providerId: 'test',
};
const service = new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }));

/** Append-only audit/revision rows cannot be DELETE'd (0145); TRUNCATE bypasses the row trigger. */
const cleanup = async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformResourceRevisions},
      ${platformAiModels},
      ${platformAiProviderSecrets},
      ${platformAiProviders}
    RESTART IDENTITY CASCADE
  `);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('AiCatalogAdminService provider draft mutations', () => {
  it('rejects copying replacement or kept credential leaves into public provider fields', async () => {
    const credential = 'arbitrary-provider-credential-leaf';
    await expect(
      service.createProviderDraft('admin', {
        description: `leak:${credential}`,
        displayName: 'Rejected',
        providerKey: 'rejected',
        reason: 'create',
        secret: { operation: 'replace', value: { apiKey: credential } },
        source: 'custom',
      }),
    ).rejects.toMatchObject({
      issues: ['Provider credentials must not appear in public catalog fields'],
    });
    expect(await db.select().from(platformAiProviders)).toEqual([]);

    const created = await service.createProviderDraft('admin', {
      displayName: 'Safe',
      providerKey: 'safe',
      reason: 'create',
      secret: { operation: 'replace', value: { apiKey: credential } },
      source: 'custom',
    });
    const detail = await service.getDetail(created.id);
    await expect(
      service.updateProviderDraft('admin', {
        displayName: credential,
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: created.id,
        reason: 'copy kept secret',
        secret: { operation: 'keep' },
      }),
    ).rejects.toMatchObject({
      issues: ['Provider credentials must not appear in public catalog fields'],
    });
    expect((await service.getDetail(created.id)).draft.displayName).toBe('Safe');

    const fresh = await service.getDetail(created.id);
    await expect(
      service.updateProviderDraft('admin', {
        expectedDraftToken: fresh.draftToken,
        expectedRevision: 0,
        id: created.id,
        logo: 'https://cdn.example.test/logo?X-Amz-Signature=unrelated-signed-value',
        reason: 'reject unrelated credential URL',
        secret: { operation: 'keep' },
      }),
    ).rejects.toMatchObject({
      issues: ['Provider credentials must not appear in public catalog fields'],
    });
  });

  it('rejects credential-shaped strings even when no platform secret exists', async () => {
    await expect(
      service.createProviderDraft('admin', {
        description: 'Bearer unrelated-public-token-value',
        displayName: 'Rejected without secret',
        providerKey: 'no-secret-rejected',
        reason: 'create',
        source: 'custom',
      }),
    ).rejects.toMatchObject({
      issues: ['Provider credentials must not appear in public catalog fields'],
    });
    expect(await db.select().from(platformAiProviders)).toEqual([]);
  });

  it('persists sanitized connection state and marks it stale after any draft mutation', async () => {
    const testedService = new AiCatalogAdminService(
      db,
      new PlatformSecretService({ keyProvider }),
      {
        connectionProbe: async () => {},
      },
    );
    const created = await testedService.createProviderDraft('admin', {
      checkModel: 'chat',
      config: { endpoint: 'https://private-test-state.example.test/v1' },
      displayName: 'Tested',
      enabled: true,
      providerKey: 'tested',
      reason: 'create',
      secret: { operation: 'replace', value: 'connection-state-secret' },
      source: 'custom',
    });
    await testedService.createModel('admin', {
      enabled: true,
      expectedDraftToken: (await testedService.getDetail(created.id)).draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'add check model',
      type: 'chat',
    });

    const result = await testedService.testProvider('admin', {
      id: created.id,
      reason: 'test current draft',
    });
    expect(result.status).toBe('success');
    let detail = await testedService.getDetail(created.id);
    expect(detail.draft.connectionTest).toMatchObject({
      stale: false,
      status: 'success',
      testedRevision: 0,
    });
    const stateJson = JSON.stringify(detail.draft.connectionTest);
    expect(stateJson).not.toContain('connection-state-secret');
    expect(stateJson).not.toContain('private-test-state.example.test');
    // Client-facing draft must never project secret fingerprint.
    expect(detail.draft.secret).toEqual(
      expect.objectContaining({ configured: true, updatedAt: expect.anything() }),
    );
    expect(detail.draft.secret).not.toHaveProperty('fingerprint');
    const [rowWithFp] = await db.select().from(platformAiProviders);
    if (rowWithFp.secretFingerprint) {
      expect(JSON.stringify(detail.draft)).not.toContain(rowWithFp.secretFingerprint);
    }

    await testedService.updateProviderDraft('admin', {
      displayName: 'Mutated after test',
      expectedDraftToken: detail.draftToken,
      expectedRevision: 0,
      id: created.id,
      reason: 'mutate',
    });
    detail = await testedService.getDetail(created.id);
    expect(detail.draft.connectionTest).toMatchObject({ stale: true, status: 'success' });
  });

  it('uses an attempt CAS so a slower old probe cannot overwrite a newer result', async () => {
    const probes: Array<{
      entered: () => void;
      enteredPromise: Promise<void>;
      promise: Promise<void>;
      reject: (error: Error) => void;
      resolve: () => void;
    }> = [];
    const createProbe = () => {
      let entered!: () => void;
      let reject!: (error: Error) => void;
      let resolve!: () => void;
      const enteredPromise = new Promise<void>((done) => {
        entered = done;
      });
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      return { entered, enteredPromise, promise, reject, resolve };
    };
    const first = createProbe();
    const second = createProbe();
    probes.push(first, second);
    let probeIndex = 0;
    const testedService = new AiCatalogAdminService(
      db,
      new PlatformSecretService({ keyProvider }),
      {
        connectionProbe: async () => {
          const probe = probes[probeIndex++];
          probe.entered();
          await probe.promise;
        },
      },
    );
    const created = await testedService.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Concurrent',
      enabled: true,
      providerKey: 'concurrent',
      reason: 'create',
      secret: { operation: 'replace', value: 'concurrent-secret' },
      source: 'custom',
    });
    await testedService.createModel('admin', {
      enabled: true,
      expectedDraftToken: (await testedService.getDetail(created.id)).draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'add check model',
      type: 'chat',
    });

    const oldAttempt = testedService.testProvider('admin', { id: created.id, reason: 'old' });
    await first.enteredPromise;
    const newAttempt = testedService.testProvider('admin', { id: created.id, reason: 'new' });
    await second.enteredPromise;
    second.resolve();
    await expect(newAttempt).resolves.toMatchObject({ status: 'success' });
    first.reject(new Error('older probe failed'));
    // Superseded older attempt must return authoritative persisted success (not the discarded failure).
    await expect(oldAttempt).resolves.toMatchObject({ status: 'success' });

    expect((await testedService.getDetail(created.id)).draft.connectionTest).toMatchObject({
      stale: false,
      status: 'success',
    });
    // Exactly one authoritative test audit (the winning attempt) — discarded probe must not
    // append a misleading failure audit via the outer catch.
    const testAudits = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.aiProviders.test',
    );
    expect(testAudits).toHaveLength(1);
    expect(testAudits[0]).toMatchObject({ result: 'success' });
  });

  it('does not failure-audit a superseded attempt while the newer probe is still pending', async () => {
    const probes: Array<{
      entered: () => void;
      enteredPromise: Promise<void>;
      promise: Promise<void>;
      resolve: () => void;
    }> = [];
    const createProbe = () => {
      let entered!: () => void;
      let resolve!: () => void;
      const enteredPromise = new Promise<void>((done) => {
        entered = done;
      });
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { entered, enteredPromise, promise, resolve };
    };
    const first = createProbe();
    const second = createProbe();
    probes.push(first, second);
    let probeIndex = 0;
    const testedService = new AiCatalogAdminService(
      db,
      new PlatformSecretService({ keyProvider }),
      {
        connectionProbe: async () => {
          const probe = probes[probeIndex++];
          probe.entered();
          await probe.promise;
        },
      },
    );
    const created = await testedService.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Pending Supersede',
      enabled: true,
      providerKey: 'pending-supersede',
      reason: 'create',
      secret: { operation: 'replace', value: 'pending-secret' },
      source: 'custom',
    });
    await testedService.createModel('admin', {
      enabled: true,
      expectedDraftToken: (await testedService.getDetail(created.id)).draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'add check model',
      type: 'chat',
    });

    const oldAttempt = testedService.testProvider('admin', { id: created.id, reason: 'old' });
    await first.enteredPromise;
    const newAttempt = testedService.testProvider('admin', { id: created.id, reason: 'new' });
    await second.enteredPromise;

    // Finish the older probe while the newer attempt is still pending.
    first.resolve();
    await expect(oldAttempt).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.stringMatching(/superseded by a newer attempt/i)]),
    });
    const midAudits = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.aiProviders.test',
    );
    expect(midAudits).toHaveLength(0);

    second.resolve();
    await expect(newAttempt).resolves.toMatchObject({ status: 'success' });
    const finalAudits = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.aiProviders.test',
    );
    expect(finalAudits).toHaveLength(1);
    expect(finalAudits[0]).toMatchObject({ result: 'success' });
  });

  it('persists only sanitized failure metadata', async () => {
    const failingService = new AiCatalogAdminService(
      db,
      new PlatformSecretService({ keyProvider }),
      {
        connectionProbe: async () => {
          throw new Error(
            'Unauthorized sk-private-connection-value at https://private-failure.example/v1',
          );
        },
      },
    );
    const created = await failingService.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Failure',
      enabled: true,
      providerKey: 'failure',
      reason: 'create',
      secret: { operation: 'replace', value: 'failure-secret' },
      source: 'custom',
    });
    await failingService.createModel('admin', {
      enabled: true,
      expectedDraftToken: (await failingService.getDetail(created.id)).draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'add check model',
      type: 'chat',
    });
    await expect(
      failingService.testProvider('admin', { id: created.id, reason: 'test failure' }),
    ).resolves.toMatchObject({ status: 'failure' });
    const connectionTest = (await failingService.getDetail(created.id)).draft.connectionTest;
    expect(connectionTest).toMatchObject({
      errorCategory: 'auth',
      stale: false,
      status: 'failure',
    });
    const json = JSON.stringify(connectionTest);
    expect(json).not.toContain('private-failure.example');
    expect(json).not.toContain('sk-private-connection-value');
    expect(json).not.toContain('failure-secret');
  });

  it('creates and reads a secret-safe draft with a CAS token and success audit', async () => {
    const credential = 'plaincredentialvalue-without-known-prefix';
    const created = await service.createProviderDraft('admin', {
      displayName: 'Alpha',
      enabled: true,
      providerKey: 'alpha',
      reason: `create provider ${credential}`,
      secret: { operation: 'replace', value: credential },
      source: 'custom',
    });
    expect(created.secret).toMatchObject({ configured: true });
    expect(created.secret).not.toHaveProperty('fingerprint');
    expect(JSON.stringify(created)).not.toContain(credential);

    const [stored] = await db.select().from(platformAiProviders);
    const [immutable] = await db.select().from(platformAiProviderSecrets);
    expect(stored.encryptedKeyVaults).toMatch(/^aihub\.secret\.v1\./);
    expect(stored.encryptedKeyVaults).not.toContain(credential);
    expect(stored.secretKeyId).toBe('draft-test');
    expect(immutable.keyId).toBe('draft-test');
    expect(stored.secretFingerprint).not.toBe(stored.secretKeyId);

    const detail = await service.getDetail(created.id);
    expect(detail.baseRevision).toBe(0);
    expect(detail.draftToken).toHaveLength(64);
    expect(detail.published).toBeNull();
    const audits = await db.select().from(platformAuditLogs);
    expect(audits).toContainEqual(
      expect.objectContaining({ action: 'admin.aiProviders.createDraft', result: 'success' }),
    );
    expect(JSON.stringify(audits)).not.toContain(credential);
  });

  it('fails the connection probe for a non-chat check model without blocking publish', async () => {
    const probe = vi.fn(async () => {});
    const unsupportedService = new AiCatalogAdminService(
      db,
      new PlatformSecretService({ keyProvider }),
      { connectionProbe: probe },
    );
    const created = await unsupportedService.createProviderDraft('admin', {
      checkModel: 'embed-only',
      displayName: 'Embedding only',
      enabled: true,
      providerKey: 'embedding-only',
      reason: 'create',
      secret: { operation: 'replace', value: 'embedding-secret' },
      source: 'custom',
    });
    await unsupportedService.createModel('admin', {
      enabled: true,
      expectedDraftToken: (await unsupportedService.getDetail(created.id)).draftToken,
      modelKey: 'embed-only',
      providerId: created.id,
      reason: 'embedding model',
      type: 'embedding',
    });

    await expect(
      unsupportedService.testProvider('admin', { id: created.id, reason: 'test unsupported' }),
    ).resolves.toMatchObject({ errorCategory: 'invalid_config', status: 'failure' });
    expect(probe).not.toHaveBeenCalled();
    const detail = await unsupportedService.getDetail(created.id);
    // The manual health check is advisory only — it never gates publish any more.
    await expect(
      unsupportedService.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: created.id,
        reason: 'publishes despite a failed probe',
      }),
    ).resolves.toMatchObject({ revision: 1 });
  });

  it('enforces draft token/revision CAS and preserves or clears secrets explicitly', async () => {
    const created = await service.createProviderDraft('admin', {
      displayName: 'Alpha',
      providerKey: 'alpha',
      reason: 'create provider',
      secret: { operation: 'replace', value: 'fake-api-key' },
      source: 'custom',
    });
    const before = await service.getDetail(created.id);
    const kept = await service.updateProviderDraft('admin', {
      displayName: 'Alpha 2',
      expectedDraftToken: before.draftToken,
      expectedRevision: 0,
      id: created.id,
      reason: 'rename',
      secret: { operation: 'keep' },
    });
    // Client DTO keeps secret configured; fingerprint is server-internal and must be absent.
    expect(kept.secret).toEqual(
      expect.objectContaining({ configured: true, updatedAt: expect.anything() }),
    );
    expect(kept.secret).not.toHaveProperty('fingerprint');
    expect(before.draft.secret).not.toHaveProperty('fingerprint');

    await expect(
      service.updateProviderDraft('admin', {
        displayName: 'stale overwrite',
        expectedDraftToken: before.draftToken,
        expectedRevision: 0,
        id: created.id,
        reason: 'stale',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect((await service.getDetail(created.id)).draft.displayName).toBe('Alpha 2');

    const fresh = await service.getDetail(created.id);
    const cleared = await service.updateProviderDraft('admin', {
      expectedDraftToken: fresh.draftToken,
      expectedRevision: 0,
      id: created.id,
      reason: 'clear secret',
      secret: { operation: 'clear' },
    });
    expect(cleared.secret).toEqual({ configured: false, updatedAt: null });
    expect(cleared.secret).not.toHaveProperty('fingerprint');
    const [clearedRow] = await db.select().from(platformAiProviders);
    expect(clearedRow.encryptedKeyVaults).toBeNull();
    expect(clearedRow.secretKeyId).toBeNull();
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.aiProviders.updateDraft', result: 'failure' }),
    );
  });
});
