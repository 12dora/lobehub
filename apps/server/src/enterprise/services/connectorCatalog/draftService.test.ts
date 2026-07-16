// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformRevisionConflictError } from '@/database/models/platform';
import { platformAuditLogs, platformConnectors } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  cleanupM09ServiceData,
  connectorToolFixture,
  ensurePendingM09ServiceSchema,
  MemoryConnectorSecretStore,
} from './catalogTestUtils';
import { ConnectorCatalogDraftService } from './draftService';

const db: LobeChatDatabase = await getTestDB();
const redirectUri = 'https://aihub.example.test/oauth/callback';

beforeAll(() => ensurePendingM09ServiceSchema(db));
beforeEach(() => cleanupM09ServiceData(db));
afterEach(() => cleanupM09ServiceData(db));

const createService = () =>
  new ConnectorCatalogDraftService(db, new MemoryConnectorSecretStore(db), redirectUri);

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
