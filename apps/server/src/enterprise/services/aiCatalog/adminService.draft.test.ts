// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformRevisionConflictError } from '@/database/models/platform';
import {
  platformAiModels,
  platformAiProviders,
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

const cleanup = async () => {
  await db.delete(platformAuditLogs);
  await db.delete(platformResourceRevisions);
  await db.delete(platformAiModels);
  await db.delete(platformAiProviders);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('AiCatalogAdminService provider draft mutations', () => {
  it('creates and reads a secret-safe draft with a CAS token and success audit', async () => {
    const created = await service.createProviderDraft('admin', {
      displayName: 'Alpha',
      enabled: true,
      providerKey: 'alpha',
      reason: 'create provider',
      secret: { operation: 'replace', value: 'fake-api-key' },
      source: 'custom',
    });
    expect(created.secret).toMatchObject({ configured: true });
    expect(JSON.stringify(created)).not.toContain('fake-api-key');

    const [stored] = await db.select().from(platformAiProviders);
    expect(stored.encryptedKeyVaults).toMatch(/^aihub\.secret\.v1\./);
    expect(stored.encryptedKeyVaults).not.toContain('fake-api-key');

    const detail = await service.getDetail(created.id);
    expect(detail.baseRevision).toBe(0);
    expect(detail.draftToken).toHaveLength(64);
    expect(detail.published).toBeNull();
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.aiProviders.createDraft', result: 'success' }),
    );
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
    expect(kept.secret.fingerprint).toBe(before.draft.secret.fingerprint);

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
    expect(cleared.secret).toEqual({ configured: false, fingerprint: null, updatedAt: null });
    expect((await db.select().from(platformAiProviders))[0].encryptedKeyVaults).toBeNull();
    expect(await db.select().from(platformAuditLogs)).toContainEqual(
      expect.objectContaining({ action: 'admin.aiProviders.updateDraft', result: 'failure' }),
    );
  });
});
