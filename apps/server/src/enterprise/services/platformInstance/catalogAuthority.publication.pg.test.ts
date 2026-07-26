/**
 * Publication-level atomicity for catalog-authority generation bumps.
 *
 * Prefer TEST_SERVER_DB=1 + DATABASE_TEST_URL for real Postgres; otherwise
 * getTestDB() applies migration 0154 on PGlite (transaction rollback still holds).
 *
 * Proves AI and Skill publish paths bump generation in the same transaction as
 * the pointer update: successful publish commits the bump; a failure after the
 * bump DML rolls generation back with the publish transaction.
 *
 * No runtime CREATE TABLE — migration 0154 owns DDL.
 *
 * @vitest-environment node
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformCatalogAuthorityModel } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import type { SkillManifest } from '../../contracts/skillCatalog';
import { skillResourceContentChecksum } from '../../contracts/skillCatalog';
import { AiCatalogAdminService } from '../aiCatalog/adminService';
import { InMemoryPlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { SkillCatalogAdminService } from '../skillCatalog/adminService';

const db: LobeChatDatabase = await getTestDB();

const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(31), keyId: 'catalog-auth-pub' }),
  providerId: 'test',
};

const skillManifest = {
  description: 'Authority publish skill',
  displayName: 'Authority publish skill',
  localizedDescriptions: {},
  localizedDisplayNames: {},
  permissions: {
    filesystem: 'none',
    network: { allowedHosts: [], enabled: false },
    tools: { allow: [] },
  },
  skillDependencies: [],
  toolDependencies: [],
} satisfies SkillManifest;

const resetAuthority = async () => {
  await db.execute(sql`
    INSERT INTO platform_catalog_authority (domain, generation, token_kind, token_value, updated_at)
    VALUES
      ('ai_catalog', 0, 'immutable_id', ${'0'.repeat(64)}, now()),
      ('skill_catalog', 0, 'immutable_id', ${'0'.repeat(64)}, now())
    ON CONFLICT (domain) DO UPDATE SET
      generation = 0,
      token_kind = 'immutable_id',
      token_value = EXCLUDED.token_value,
      updated_at = now()
  `);
};

const peek = async (domain: 'ai_catalog' | 'skill_catalog') =>
  new PlatformCatalogAuthorityModel(db).peekGeneration(domain);

/**
 * Run the real bump DML, then throw so the surrounding publish transaction rolls back.
 * Proves the bump is not auto-committed outside the publish tx.
 */
const installPostBumpAbort = () => {
  const original = PlatformCatalogAuthorityModel.prototype.bumpGeneration;
  return vi
    .spyOn(PlatformCatalogAuthorityModel.prototype, 'bumpGeneration')
    .mockImplementation(async function (this: PlatformCatalogAuthorityModel, domain) {
      await original.call(this, domain);
      throw new Error('force_publish_rollback_after_bump');
    });
};

describe('catalog authority publication atomicity', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await resetAuthority();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await resetAuthority();
  });

  it('AI publish commits generation with the pointer and rolls back on mid-tx failure', async () => {
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const service = new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }), {
      connectionProbe: async () => {},
      invalidation,
    });

    await expect(peek('ai_catalog')).resolves.toMatchObject({ generation: 0 });

    const provider = await service.createProviderDraft('admin', {
      checkModel: 'chat',
      displayName: 'Authority AI',
      enabled: true,
      providerKey: `authority-ai-${Date.now()}`,
      reason: 'create',
      secret: { operation: 'replace', value: 'fake-key' },
      source: 'custom',
    });
    let detail = await service.getDetail(provider.id);
    await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'chat',
      providerId: provider.id,
      reason: 'model',
    });
    await service.testProvider('admin', { id: provider.id, reason: 'test' });
    detail = await service.getDetail(provider.id);

    // Commit path: real publish advances generation with the pointer.
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 0,
      id: provider.id,
      reason: 'publish commits bump',
    });
    await expect(peek('ai_catalog')).resolves.toMatchObject({ generation: 1 });
    expect((await service.getDetail(provider.id)).published?.revision).toBe(1);

    // Prepare second publish (draft mutation invalidates connection test).
    detail = await service.getDetail(provider.id);
    const modelId = detail.draft.models[0]!.id;
    await service.updateModel('admin', {
      displayName: 'Authority AI chat v2',
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: modelId,
      providerId: provider.id,
      reason: 'edit model',
    });
    await service.testProvider('admin', { id: provider.id, reason: 'retest' });
    detail = await service.getDetail(provider.id);

    // Rollback path: bump DML runs inside publish tx, then abort → generation stays at 1.
    const spy = installPostBumpAbort();
    await expect(
      service.publishProvider('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 1,
        id: provider.id,
        reason: 'should roll back after bump',
      }),
    ).rejects.toThrow('force_publish_rollback_after_bump');
    spy.mockRestore();

    await expect(peek('ai_catalog')).resolves.toMatchObject({ generation: 1 });
    expect((await service.getDetail(provider.id)).published?.revision).toBe(1);

    // Successful retry advances generation again (reader observes committed bump).
    await service.testProvider('admin', { id: provider.id, reason: 'retest-ok' });
    detail = await service.getDetail(provider.id);
    await service.publishProvider('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: 1,
      id: provider.id,
      reason: 'publish commits again',
    });
    await expect(peek('ai_catalog')).resolves.toMatchObject({ generation: 2 });
    expect((await service.getDetail(provider.id)).published?.revision).toBe(2);
  });

  it('Skill publish commits generation with the pointer and rolls back on mid-tx failure', async () => {
    const invalidation = new InMemoryPlatformConfigInvalidationPublisher();
    const service = new SkillCatalogAdminService(db, {
      builtinSkillKeys: new Set<string>(),
      invalidation,
    });

    await expect(peek('skill_catalog')).resolves.toMatchObject({ generation: 0 });

    const draft = await service.create('admin', {
      allowBuiltinOverride: false,
      displayName: 'Authority skill',
      distribution: 'default',
      enabled: true,
      reason: 'create',
      skillKey: `authority.skill.${Date.now()}`,
    });

    const resources = [
      {
        checksum: skillResourceContentChecksum('reference'),
        content: 'reference',
        mediaType: 'text/plain',
        path: 'references/source.txt',
        sizeBytes: new TextEncoder().encode('reference').byteLength,
      },
    ];
    const version = await service.createVersion('admin', {
      content: '# v1',
      contentRef: null,
      expectedDraftToken: draft.draftToken,
      expectedRevision: draft.draft.revision,
      manifest: skillManifest,
      reason: 'version',
      resources,
      skillId: draft.draft.id,
      version: '1.0.0',
    });

    let detail = await service.getDetail(draft.draft.id);
    const validation = await service.validate('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      reason: 'validate',
      skillId: draft.draft.id,
      versionId: version.id,
    });
    expect(validation.issues.filter((i) => i.severity === 'error')).toEqual([]);

    detail = await service.getDetail(draft.draft.id);
    await service.publish('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'publish commits bump',
      versionId: version.id,
    });
    await expect(peek('skill_catalog')).resolves.toMatchObject({ generation: 1 });

    // Second version for a follow-up publish that will abort after bump.
    detail = await service.getDetail(draft.draft.id);
    const v2 = await service.createVersion('admin', {
      content: '# v2',
      contentRef: null,
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      manifest: skillManifest,
      reason: 'version2',
      resources,
      skillId: draft.draft.id,
      version: '2.0.0',
    });
    detail = await service.getDetail(draft.draft.id);
    await service.validate('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      reason: 'validate v2',
      skillId: draft.draft.id,
      versionId: v2.id,
    });
    detail = await service.getDetail(draft.draft.id);

    const spy = installPostBumpAbort();
    await expect(
      service.publish('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: draft.draft.id,
        reason: 'should roll back after bump',
        versionId: v2.id,
      }),
    ).rejects.toThrow('force_publish_rollback_after_bump');
    spy.mockRestore();

    await expect(peek('skill_catalog')).resolves.toMatchObject({ generation: 1 });

    // Successful republish commits the next generation.
    detail = await service.getDetail(draft.draft.id);
    await service.publish('admin', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'publish commits again',
      versionId: v2.id,
    });
    await expect(peek('skill_catalog')).resolves.toMatchObject({ generation: 2 });
  });
});
