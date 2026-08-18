// @vitest-environment node
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { platformJobs, platformResourceRevisions } from '@/database/schemas';

import { AiCatalogAdminService } from './adminService';
import { AiCatalogNotFoundError, AiCatalogProviderUnavailableError } from './errors';
import { AiCatalogExecutionResolver } from './runtimeAdapter';
import { cleanup, createPublishedProvider, db, secretService } from './runtimeAdapter.testFixtures';
import { SharedOAuthRefreshPersistError } from './sharedOAuthRefresh';

beforeEach(cleanup);
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

  it('treats a secret-less pinned revision as terminal, not BYOK', async () => {
    // Env fallback would make the current pointer succeed; this pin is about a
    // historical revision whose secret is gone, which must stay terminal.
    delete process.env.OPENAI_API_KEY;
    const { provider, service } = await createPublishedProvider();
    const detail = await service.getDetail(provider.id);
    const cleared = await service.applyProviderImmediate('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: provider.id,
      mode: 'update',
      reason: 'clear stored secret',
      secret: { operation: 'clear' },
    });
    const [clearedRevision] = await db
      .select()
      .from(platformResourceRevisions)
      .where(
        and(
          eq(platformResourceRevisions.resourceId, provider.id),
          eq(platformResourceRevisions.revision, cleared.revision),
        ),
      );

    const execution = new AiCatalogExecutionResolver(db, secretService);
    await expect(execution.resolveProviderExecutionConfig('alpha')).rejects.toBeInstanceOf(
      AiCatalogNotFoundError,
    );
    await expect(
      execution.resolveProviderExecutionConfigAtRevision({
        modelKey: 'chat',
        providerChecksum: clearedRevision.checksum!,
        providerKey: 'alpha',
        providerRevision: cleared.revision,
      }),
    ).rejects.toBeInstanceOf(AiCatalogProviderUnavailableError);
  });

  it('does not execute on the stored vault after a post-exchange persist failure', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    const service = new AiCatalogAdminService(db, secretService, {
      connectionProbe: async () => {},
    });
    await service.applyProviderImmediate('admin', {
      displayName: 'Shared grok',
      enabled: true,
      mode: 'create',
      providerKey: 'supergrok',
      reason: 'seed oauth',
      secret: {
        operation: 'replace',
        value: {
          oauthAccessToken: 'at-old',
          oauthRefreshToken: 'rt-old',
          oauthTokenExpiresAt: String(Date.now() + 30_000),
        },
      },
      source: 'builtin',
    });

    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'at-new',
            expires_in: 3600,
            refresh_token: 'rt-new',
            token_type: 'bearer',
          }),
          { status: 200 },
        ),
    ) as typeof fetch;
    const encryptSpy = vi
      .spyOn(secretService, 'encrypt')
      .mockRejectedValue(new Error('kek write failed'));

    try {
      const execution = new AiCatalogExecutionResolver(db, secretService);
      await expect(execution.resolveProviderExecutionConfig('supergrok')).rejects.toBeInstanceOf(
        SharedOAuthRefreshPersistError,
      );
      expect(globalThis.fetch).toHaveBeenCalled();
    } finally {
      encryptSpy.mockRestore();
      globalThis.fetch = realFetch;
      await db.execute(sql`TRUNCATE TABLE ${platformJobs} RESTART IDENTITY CASCADE`);
    }
  });
});
