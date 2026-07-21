// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import {
  platformAiModels,
  platformAiProviders,
  platformAiProviderSecrets,
  platformAuditLogs,
  platformResourceRevisions,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { AiCatalogAdminService, AiCatalogValidationError } from './adminService';
import {
  AiCatalogRuntimeAdapter,
  clearAiCatalogRuntimeCache,
  getEmptyAiProviderRuntimeState,
} from './runtimeAdapter';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(41), keyId: 'apply-imm' }),
  providerId: 'test',
};

const cleanup = async () => {
  await db.delete(platformAuditLogs);
  await db.delete(platformResourceRevisions);
  await db.delete(platformAiModels);
  await db.delete(platformAiProviderSecrets);
  await db.delete(platformAiProviders);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await cleanup();
});
afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const createService = (connectionProbe: () => Promise<void> = async () => {}) =>
  new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }), {
    connectionProbe,
  });

describe('AiCatalogAdminService applyImmediate first-publish retest', () => {
  it('auto retests and publishes on revision 0 when credentials + enabled model exist', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'First',
      enabled: true,
      providerKey: 'first-auto',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
    });
    let detail = await service.getDetail(created.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'model',
      type: 'chat',
    });
    detail = await service.getDetail(created.id);
    const result = await service.applyProviderImmediate('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      mode: 'update',
      reason: 'nudge publish',
    });
    expect(result.published).toBe(true);
    expect(result.revision).toBeGreaterThan(0);
  });

  it('soft-returns published:false when connection test fails on first publish', async () => {
    const service = createService(async () => {
      throw new Error('network down');
    });
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'Fail test',
      enabled: true,
      providerKey: 'fail-test',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
    });
    let detail = await service.getDetail(created.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'model',
      type: 'chat',
    });
    detail = await service.getDetail(created.id);
    const result = await service.applyProviderImmediate('admin', {
      displayName: 'Still draft',
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      mode: 'update',
      reason: 'try publish',
    });
    // update mode on revision 0 soft-fails via tryPublish when baseRevision stays 0
    // applyProviderImmediate rethrows for update when baseRevision > 0 only
    expect(result.published).toBe(false);
    expect(result.publishError).toBeTruthy();
    expect(result.revision).toBe(0);
  });

  it('does not auto retest when revision > 0 (allowStaleConnectionTest path)', async () => {
    let probeCount = 0;
    const service = createService(async () => {
      probeCount += 1;
    });
    // Seed published provider
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'Live',
      enabled: true,
      providerKey: 'live-p',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
    });
    let detail = await service.getDetail(created.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'model',
      type: 'chat',
    });
    await service.testProvider('admin', { id: created.id, reason: 'prime' });
    detail = await service.getDetail(created.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'first publish',
    });
    probeCount = 0;
    detail = await service.getDetail(created.id);
    await service.applyProviderImmediate('admin', {
      displayName: 'Renamed live',
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      mode: 'update',
      reason: 'rename',
    });
    expect(probeCount).toBe(0);
  });

  it('publishNow retests revision 0 and publishes', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'Now',
      enabled: true,
      providerKey: 'publish-now',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
    });
    const detail = await service.getDetail(created.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'model',
      type: 'chat',
    });
    const result = await service.publishNow('admin', {
      id: created.id,
      reason: 'banner retry',
    });
    expect(result.published).toBe(true);
    expect(result.revision).toBeGreaterThan(0);
  });

  it('applyModelImmediate create then publishes with auto retest on revision 0', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'Models',
      enabled: true,
      providerKey: 'models-p',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
    });
    const detail = await service.getDetail(created.id);
    const result = await service.applyModelImmediate('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      operation: 'create',
      providerId: created.id,
      reason: 'add model',
      type: 'chat',
    });
    expect(result.published).toBe(true);
    expect(result.revision).toBeGreaterThan(0);
  });

  it('toggle-off published provider publishes enabled:false revision (global disable)', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'Disable Me',
      enabled: true,
      providerKey: 'disable-pub',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
    });
    let detail = await service.getDetail(created.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'model',
      type: 'chat',
    });
    await service.testProvider('admin', { id: created.id, reason: 'prime' });
    detail = await service.getDetail(created.id);
    const first = await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'first publish',
    });
    detail = await service.getDetail(created.id);
    const off = await service.applyProviderImmediate('admin', {
      enabled: false,
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      mode: 'update',
      reason: 'global disable',
    });
    expect(off.published).toBe(true);
    expect(off.draft.enabled).toBe(false);
    expect(off.revision).toBeGreaterThan(first.revision);

    // Runtime materialization must exclude published-disabled providers.
    clearAiCatalogRuntimeCache();
    const runtime = await new AiCatalogRuntimeAdapter(db).resolve({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true },
      upstreamState: getEmptyAiProviderRuntimeState(),
    });
    expect(runtime.enabledAiProviders.map((p) => p.id)).not.toContain('disable-pub');
    expect(runtime.enabledAiModels.every((m) => m.providerId !== 'disable-pub')).toBe(true);

    // OFF → ON recovers without extra obstacles (stale connection test allowed).
    detail = await service.getDetail(created.id);
    const on = await service.applyProviderImmediate('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      mode: 'update',
      reason: 're-enable',
    });
    expect(on.published).toBe(true);
    expect(on.draft.enabled).toBe(true);

    clearAiCatalogRuntimeCache();
    const runtimeOn = await new AiCatalogRuntimeAdapter(db).resolve({
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true },
      upstreamState: getEmptyAiProviderRuntimeState(),
    });
    expect(runtimeOn.enabledAiProviders.map((p) => p.id)).toContain('disable-pub');
  });

  it('revision 0 disable publish is still rejected (first publish must be enabled)', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      displayName: 'Never Live',
      enabled: false,
      providerKey: 'rev0-off',
      reason: 'create disabled',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
    });
    const detail = await service.getDetail(created.id);
    const result = await service.applyProviderImmediate('admin', {
      enabled: false,
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      mode: 'update',
      reason: 'cannot first-publish disabled',
    });
    // Soft path on revision 0: draft kept, not published.
    expect(result.published).toBe(false);
    expect(result.revision).toBe(0);
  });

  /**
   * R2 "update failure visibility" — rewritten after F1 semantic change:
   * disable is now a valid publish; use invalid endpoint on a still-enabled
   * published provider so publish validation still throws (not soft-return).
   */
  it('update on published provider throws when publish validation fails (not soft-return)', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      checkModel: 'chat',
      displayName: 'Throwing',
      enabled: true,
      providerKey: 'throw-pub',
      reason: 'create',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
    });
    let detail = await service.getDetail(created.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: created.id,
      reason: 'model',
      type: 'chat',
    });
    await service.testProvider('admin', { id: created.id, reason: 'prime' });
    detail = await service.getDetail(created.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'first publish',
    });
    detail = await service.getDetail(created.id);
    await expect(
      service.applyProviderImmediate('admin', {
        config: { endpoint: 'not-a-valid-url' },
        enabled: true,
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: created.id,
        mode: 'update',
        reason: 'invalid endpoint must throw',
      }),
    ).rejects.toBeInstanceOf(AiCatalogValidationError);
  });

  it('secret merge keeps unsubmitted apiKey when only baseURL-equivalent fields are absent', async () => {
    const service = createService(async () => {});
    const created = await service.createProviderDraft('admin', {
      source: 'custom',
      displayName: 'Merge',
      enabled: true,
      providerKey: 'merge-p',
      reason: 'create',
      secret: { operation: 'replace', value: { apiKey: 'keep-key' } },
      settings: { sdkType: 'openai' },
    });
    const detail = await service.getDetail(created.id);
    // Empty merge payload fields are ignored — vault apiKey retained.
    await service.updateProviderDraft('admin', {
      config: { endpoint: 'https://public.endpoint' },
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: created.id,
      reason: 'public endpoint only',
      secret: { operation: 'merge', value: { apiKey: '' } },
    });
    const [row] = await db
      .select()
      .from(platformAiProviders)
      .where(eq(platformAiProviders.id, created.id));
    const secrets = new PlatformSecretService({ keyProvider });
    const vault = JSON.parse(await secrets.decrypt(row.encryptedKeyVaults!));
    expect(vault).toEqual({ apiKey: 'keep-key' });
    expect(row.config).toMatchObject({ endpoint: 'https://public.endpoint' });
  });
});
