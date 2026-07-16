// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformRevisionConflictError } from '@/database/models/platform';
import { platformAuditLogs, platformConnectors } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { ConnectorFailureAuditWriter } from './catalogAudit';
import {
  cleanupM09ServiceData,
  connectorToolFixture,
  ensurePendingM09ServiceSchema,
  MemoryConnectorSecretStore,
} from './catalogTestUtils';
import type { ConnectorCatalogLifecycle } from './catalogTypes';
import { ConnectorCatalogDraftService } from './draftService';

const db: LobeChatDatabase = await getTestDB();
const redirectUri = 'https://aihub.example.test/oauth/callback';

beforeAll(() => ensurePendingM09ServiceSchema(db));
beforeEach(() => cleanupM09ServiceData(db));
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupM09ServiceData(db);
});

const createService = (
  failureAuditWriter?: ConnectorFailureAuditWriter,
  secrets = new MemoryConnectorSecretStore(db),
  lifecycle: ConnectorCatalogLifecycle = {},
) => new ConnectorCatalogDraftService(db, secrets, redirectUri, failureAuditWriter, lifecycle);

describe('ConnectorCatalogDraftService', () => {
  it('creates, reads, and filters a strict connector Draft with an audit record', async () => {
    const service = createService();
    const created = await service.createDraft('admin-user', {
      credentialMode: 'none',
      displayName: 'Internal Search',
      endpoint: 'https://connector.example.test/mcp',
      key: 'internal-search',
      reason: 'create safe connector',
      tools: [connectorToolFixture()],
      transport: 'http',
    });

    expect(created.draft).toMatchObject({
      credentialMode: 'none',
      key: 'internal-search',
      revision: 0,
      status: 'draft',
    });
    expect(created.draft.tools).toHaveLength(1);
    expect(created.draftToken).toHaveLength(64);
    await expect(service.getDraft(created.draft.id)).resolves.toEqual(created);
    await expect(service.listDrafts({ limit: 10, query: 'INTERNAL' })).resolves.toMatchObject({
      items: [{ key: 'internal-search' }],
      nextCursor: null,
    });
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.connectors.createDraft', result: 'success' }),
    );
    expect(JSON.stringify(await db.select().from(platformAuditLogs))).not.toContain('inputSchema');
  });

  it('applies filters before pagination and advances the key cursor without N+1 detail reads', async () => {
    const service = createService();
    for (const [key, enabled] of [
      ['alpha-hidden', false],
      ['beta-visible', true],
      ['gamma-visible', true],
    ] as const) {
      await service.createDraft('admin-user', {
        credentialMode: 'none',
        displayName: key,
        enabled,
        endpoint: 'https://connector.example.test/mcp',
        key,
        reason: `create ${key}`,
        transport: 'http',
      });
    }

    const first = await service.listDrafts({ enabled: true, limit: 1, query: 'visible' });
    expect(first).toMatchObject({
      items: [{ key: 'beta-visible' }],
      nextCursor: 'beta-visible',
    });
    await expect(
      service.listDrafts({ cursor: first.nextCursor!, enabled: true, limit: 1, query: 'visible' }),
    ).resolves.toMatchObject({ items: [{ key: 'gamma-visible' }], nextCursor: null });
  });

  it('applies secret replace/keep without echo and rejects stale revision or Draft token', async () => {
    const secret = 'shared-service-account-value-never-echo';
    const service = createService();
    const created = await service.createDraft('admin-user', {
      credentialMode: 'shared_service_account',
      displayName: 'Shared Connector',
      endpoint: 'https://connector.example.test/mcp',
      key: 'shared-connector',
      reason: 'create shared connector',
      sharedSecret: { operation: 'replace', value: { apiKey: secret } },
      transport: 'http',
    });
    expect(created.draft.sharedSecret).toMatchObject({ configured: true });
    expect(JSON.stringify(created)).not.toContain(secret);

    const updated = await service.updateDraft('admin-user', {
      displayName: 'Shared Connector Updated',
      expectedDraftToken: created.draftToken,
      expectedRevision: 0,
      id: created.draft.id,
      reason: 'update metadata',
      sharedSecret: { operation: 'keep' },
    });
    expect(updated.draft).toMatchObject({
      displayName: 'Shared Connector Updated',
      revision: 1,
    });
    expect(updated.draft.sharedSecret.fingerprint).toBe(created.draft.sharedSecret.fingerprint);

    await expect(
      service.updateDraft('admin-user', {
        displayName: 'stale overwrite',
        expectedDraftToken: created.draftToken,
        expectedRevision: 0,
        id: created.draft.id,
        reason: 'stale write',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect(JSON.stringify(await db.select().from(platformAuditLogs))).not.toContain(secret);
  });

  it('persists replacement handles before locking and leaves a safe orphan after a losing CAS', async () => {
    const secrets = new MemoryConnectorSecretStore(db);
    const lifecycle: ConnectorCatalogLifecycle = {};
    const service = createService(undefined, secrets, lifecycle);
    const created = await service.createDraft('admin-user', {
      credentialMode: 'shared_service_account',
      displayName: 'Orphan Handle Connector',
      endpoint: 'https://connector.example.test/mcp',
      key: 'orphan-handle-connector',
      reason: 'create connector',
      sharedSecret: { operation: 'replace', value: { apiKey: 'original-secret' } },
      transport: 'http',
    });
    const persist = secrets.persistSecret;
    let orphan: Awaited<ReturnType<typeof persist>> | undefined;
    vi.spyOn(secrets, 'persistSecret').mockImplementation(async (params) => {
      orphan = await persist(params);
      return orphan;
    });
    lifecycle.afterDraftSecretPersist = async (connectorId) => {
      await db
        .update(platformConnectors)
        .set({ revision: 1 })
        .where(eq(platformConnectors.id, connectorId));
    };

    await expect(
      service.updateDraft('admin-user', {
        expectedDraftToken: created.draftToken,
        expectedRevision: 0,
        id: created.draft.id,
        reason: 'rotate connector secret',
        sharedSecret: { operation: 'replace', value: { apiKey: 'orphaned-secret' } },
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect(orphan).toBeDefined();
    await expect(
      secrets.resolveSecretVersion({
        connectorId: created.draft.id,
        fingerprint: orphan!.fingerprint,
        slot: 'sharedSecret',
      }),
    ).resolves.toMatchObject({ ref: orphan!.ref });
    const [connector] = await db.select().from(platformConnectors);
    expect(connector.sharedSecretFingerprint).toBe(created.draft.sharedSecret.fingerprint);
  });

  it('preserves the original CAS error when best-effort failure audit persistence is down', async () => {
    const service = createService();
    const created = await service.createDraft('admin-user', {
      credentialMode: 'none',
      displayName: 'CAS Connector',
      endpoint: 'https://connector.example.test/mcp',
      key: 'cas-connector',
      reason: 'create connector',
      transport: 'http',
    });
    const failureAuditWriter = vi.fn(async () => {
      throw new Error('audit-backend-private-response');
    });
    const failingService = createService(failureAuditWriter);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      failingService.updateDraft('admin-user', {
        displayName: 'stale update',
        expectedDraftToken: '0'.repeat(64),
        expectedRevision: 0,
        id: created.draft.id,
        reason: 'safe stale update reason',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect(failureAuditWriter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'safe stale update reason' }),
    );
  });

  it('physically deletes only an unpublished Draft with both CAS values', async () => {
    const service = createService();
    const created = await service.createDraft('admin-user', {
      credentialMode: 'none',
      displayName: 'Disposable Connector',
      endpoint: 'https://connector.example.test/mcp',
      key: 'disposable-connector',
      reason: 'create disposable connector',
      transport: 'http',
    });
    await expect(
      service.deleteDraft('admin-user', {
        expectedDraftToken: '0'.repeat(64),
        expectedRevision: 0,
        id: created.draft.id,
        reason: 'stale delete',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    await expect(
      service.deleteDraft('admin-user', {
        expectedDraftToken: created.draftToken,
        expectedRevision: 0,
        id: created.draft.id,
        reason: 'delete unused connector',
      }),
    ).resolves.toMatchObject({ auditId: expect.any(String) });
    expect(await db.select().from(platformConnectors)).toEqual([]);
  });
});
