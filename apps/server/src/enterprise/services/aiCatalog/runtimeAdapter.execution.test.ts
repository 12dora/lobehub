// @vitest-environment node
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { platformResourceRevisions } from '@/database/schemas';

import { AiCatalogExecutionResolver } from './runtimeAdapter';
import { cleanup, createPublishedProvider, db, secretService } from './runtimeAdapter.testFixtures';

beforeEach(cleanup);
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

describe('AiCatalogExecutionResolver — exact historical revision (MODEL-EXACT)', () => {
  const publishV2 = async (
    service: Awaited<ReturnType<typeof createPublishedProvider>>['service'],
    providerId: string,
  ) => {
    let detail = await service.getDetail(providerId);
    await service.updateProviderDraft('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: providerId,
      reason: 'replace draft',
      secret: { operation: 'replace', value: 'published-key-v2' },
    });
    await service.testProvider('admin', { id: providerId, reason: 'test v2' });
    detail = await service.getDetail(providerId);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: providerId,
      reason: 'publish v2',
    });
  };

  it('resolves the pinned v1 config after v2 becomes current, and fails closed on mismatch', async () => {
    const { provider, service } = await createPublishedProvider();
    const [v1] = await db
      .select()
      .from(platformResourceRevisions)
      .where(
        and(
          eq(platformResourceRevisions.resourceId, provider.id),
          eq(platformResourceRevisions.revision, 1),
        ),
      );
    const v1Checksum = v1.checksum!;
    await publishV2(service, provider.id);

    const execution = new AiCatalogExecutionResolver(db, secretService);
    // The current/latest pointer is now v2 …
    expect((await execution.resolveProviderExecutionConfig('alpha')).keyVaults.apiKey).toBe(
      'published-key-v2',
    );
    // … but the exact pinned v1 still resolves v1's historical config + credentials.
    const exact = await execution.resolveProviderExecutionConfigAtRevision({
      modelKey: 'chat',
      providerChecksum: v1Checksum,
      providerKey: 'alpha',
      providerRevision: 1,
    });
    expect(exact.revision).toBe(1);
    expect(exact.keyVaults.apiKey).toBe('published-key-v1');

    // Fail closed: checksum mismatch, missing revision, disabled/unknown model, unknown provider.
    await expect(
      execution.resolveProviderExecutionConfigAtRevision({
        modelKey: 'chat',
        providerChecksum: 'f'.repeat(64),
        providerKey: 'alpha',
        providerRevision: 1,
      }),
    ).rejects.toThrow();
    await expect(
      execution.resolveProviderExecutionConfigAtRevision({
        modelKey: 'chat',
        providerChecksum: v1Checksum,
        providerKey: 'alpha',
        providerRevision: 99,
      }),
    ).rejects.toThrow();
    await expect(
      execution.resolveProviderExecutionConfigAtRevision({
        modelKey: 'not-published',
        providerChecksum: v1Checksum,
        providerKey: 'alpha',
        providerRevision: 1,
      }),
    ).rejects.toThrow();
    await expect(
      execution.resolveProviderExecutionConfigAtRevision({
        modelKey: 'chat',
        providerChecksum: v1Checksum,
        providerKey: 'unknown-provider',
        providerRevision: 1,
      }),
    ).rejects.toThrow();
  });
});
