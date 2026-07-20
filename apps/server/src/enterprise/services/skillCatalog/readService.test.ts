// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import {
  PlatformSkillCatalogModel,
  platformSkillVersionChecksum,
} from '@/database/models/platform';
import { PlatformSkillCatalogRepository } from '@/database/repositories/platformSkillCatalog';
import {
  platformResourceRevisions,
  platformSkills,
  platformSkillVersions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { SkillManifest } from '../../contracts/skillCatalog';
import { PlatformDomainTargetResolver } from '../platformInstance/domainTargets';
import type { PlatformRuntimeMaterializationReporter } from '../platformInstance/runtimeReporter';
import {
  type BuiltinSkillDefinition,
  invalidatePublishedSkillCatalogReadCache,
  resetPublishedSkillCatalogReadCacheForTest,
  SkillCatalogReadService,
} from './readService';
import { resolvePinnedPlatformSkillRuntimeSnapshot } from './runtimeSnapshot';

const db: LobeChatDatabase = await getTestDB();

const deferred = <T>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  return { promise, reject, resolve };
};

const manifest = {
  description: 'Published Skill',
  displayName: 'Published Skill',
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

const cleanup = async () => {
  resetPublishedSkillCatalogReadCacheForTest();
  await db.execute(
    sql`TRUNCATE TABLE ${platformResourceRevisions}, ${platformSkillVersions}, ${platformSkills} CASCADE`,
  );
};

beforeEach(cleanup);
afterEach(async () => {
  await cleanup();
});

const publish = async (params: {
  allowBuiltinOverride?: boolean;
  contentRef?: string | null;
  revision?: number;
  skillId?: string;
  skillKey: string;
  version: string;
}) => {
  const repository = new PlatformSkillCatalogRepository(db);
  const skill = params.skillId
    ? (await repository.getSkill(params.skillId))!
    : await repository.createSkill({
        allowBuiltinOverride: params.allowBuiltinOverride,
        enabled: false,
        name: 'Mutable draft name',
        skillKey: params.skillKey,
      });
  const content = `# ${params.version}`;
  const contentRef = params.contentRef === undefined ? 'opaque:skill-content-1' : params.contentRef;
  const resources = [
    {
      checksum: 'a'.repeat(64),
      content: 'reference',
      mediaType: 'text/plain',
      path: 'references/source.txt',
      sizeBytes: 9,
    },
  ];
  const version = await repository.createVersion({
    checksum: platformSkillVersionChecksum({ content, contentRef, manifest, resources }),
    content,
    contentRef,
    manifest,
    resources,
    skillId: skill.id,
    version: params.version,
  });
  const revision = params.revision ?? 1;
  await db.insert(platformResourceRevisions).values({
    checksum: `revision-${revision}`,
    payload: {
      skill: {
        allowBuiltinOverride: params.allowBuiltinOverride ?? false,
        description: 'Immutable published description',
        displayName: 'Immutable published name',
        distribution: 'default',
        enabled: true,
        skillKey: params.skillKey,
        source: 'uploaded',
      },
      versionId: version.id,
    },
    resourceId: skill.id,
    resourceType: 'skill',
    revision,
    status: 'published',
  });
  await repository.updateSkill(skill.id, {
    currentVersionId: version.id,
    revision,
    status: 'published',
  });
  return { skill, version };
};

describe('SkillCatalogReadService', () => {
  it('returns public allowlisted metadata and exact server-only immutable resources', async () => {
    const { version } = await publish({ skillKey: 'approved.search', version: '1.0.0' });
    const service = new SkillCatalogReadService(db);
    const catalog = await service.getPublishedCatalog();
    expect(catalog.skills).toEqual([
      expect.objectContaining({
        displayName: 'Immutable published name',
        skillKey: 'approved.search',
      }),
    ]);
    expect(JSON.stringify(catalog)).not.toContain('opaque:skill-content-1');
    expect(JSON.stringify(catalog)).not.toContain('# 1.0.0');
    await expect(service.resolveForExecution('approved.search', '1.0.0')).resolves.toMatchObject({
      content: '# 1.0.0',
      contentRef: 'opaque:skill-content-1',
      resources: [expect.objectContaining({ path: 'references/source.txt' })],
      versionId: version.id,
    });
  });

  it('keeps an exact historical version resolvable after the current head is archived', async () => {
    const { skill } = await publish({ skillKey: 'historical', version: '1.0.0' });
    await db.insert(platformResourceRevisions).values({
      checksum: 'archived-head',
      payload: {},
      resourceId: skill.id,
      resourceType: 'skill',
      revision: 2,
      status: 'archived',
    });
    await new PlatformSkillCatalogRepository(db).updateSkill(skill.id, {
      revision: 2,
      status: 'archived',
    });
    const service = new SkillCatalogReadService(db);
    await expect(service.resolveForExecution('historical')).resolves.toBeUndefined();
    await expect(service.resolveForExecution('historical', '1.0.0')).resolves.toMatchObject({
      content: '# 1.0.0',
    });
    const exact = await service.resolveForExecution('historical', '1.0.0');
    await expect(
      service.resolvePinnedForExecution({
        checksum: exact!.checksum,
        skillKey: 'historical',
        version: '1.0.0',
      }),
    ).resolves.toMatchObject({ content: '# 1.0.0' });
  });

  it('fails closed when either coordinate of a pinned execution ref does not match', async () => {
    const service = new SkillCatalogReadService(db);
    await publish({ skillKey: 'pinned', version: '1.0.0' });
    const exact = await service.resolveForExecution('pinned', '1.0.0');

    await expect(
      service.resolvePinnedForExecution({
        checksum: 'f'.repeat(64),
        skillKey: 'pinned',
        version: '1.0.0',
      }),
    ).resolves.toBeUndefined();
    await expect(
      service.resolvePinnedForExecution({
        checksum: exact!.checksum,
        skillKey: 'pinned',
        version: '2.0.0',
      }),
    ).resolves.toBeUndefined();
  });

  it('requires explicit published override intent before replacing a builtin key', async () => {
    const builtin: BuiltinSkillDefinition = {
      checksum: 'b'.repeat(64),
      content: '# builtin',
      description: 'Builtin',
      displayName: 'Builtin',
      distribution: 'default',
      manifest,
      skillKey: 'builtin.search',
      source: 'builtin',
      version: '1.0.0',
    };
    const first = await publish({ skillKey: 'builtin.search', version: '2.0.0' });
    let service = new SkillCatalogReadService(db, { builtinSkills: [builtin] });
    const beforeOverride = await service.getPublishedCatalog();
    expect(beforeOverride.skills).toEqual([
      expect.objectContaining({ source: 'builtin', version: '1.0.0' }),
    ]);
    expect(await service.resolveForExecution('builtin.search', '2.0.0')).toBeUndefined();

    await publish({
      allowBuiltinOverride: true,
      revision: 2,
      skillId: first.skill.id,
      skillKey: 'builtin.search',
      version: '3.0.0',
    });
    invalidatePublishedSkillCatalogReadCache();
    service = new SkillCatalogReadService(db, { builtinSkills: [builtin] });
    const afterOverride = await service.getPublishedCatalog();
    expect(afterOverride.skills).toEqual([
      expect.objectContaining({ source: 'uploaded', version: '3.0.0' }),
    ]);
    expect(afterOverride.revision).not.toBe(beforeOverride.revision);
  });

  it('reads every bounded repository page and preserves global codepoint ordering', async () => {
    for (let index = 100; index >= 0; index -= 1) {
      await publish({ skillKey: `paged-${String(index).padStart(3, '0')}`, version: '1.0.0' });
    }
    const catalog = await new SkillCatalogReadService(db).getPublishedCatalog();
    expect(catalog.skills).toHaveLength(101);
    expect(catalog.skills[0]?.skillKey).toBe('paged-000');
    expect(catalog.skills.at(-1)?.skillKey).toBe('paged-100');
  });

  it('derives revision from final builtin projection and rejects injected builtin fields', async () => {
    const builtin: BuiltinSkillDefinition = {
      checksum: 'b'.repeat(64),
      content: '# builtin',
      description: 'Builtin',
      displayName: 'Builtin',
      distribution: 'default',
      manifest,
      skillKey: 'builtin.strict',
      source: 'builtin',
      version: '1.0.0',
    };
    const first = await new SkillCatalogReadService(db, {
      builtinSkills: [builtin],
    }).getPublishedCatalog();
    const second = await new SkillCatalogReadService(db, {
      builtinSkills: [{ ...builtin, checksum: 'c'.repeat(64), content: '# changed builtin' }],
    }).getPublishedCatalog();
    expect(second.revision).not.toBe(first.revision);
    expect(
      () =>
        new SkillCatalogReadService(db, {
          builtinSkills: [{ ...builtin, draftOnly: true } as never],
        }),
    ).toThrow();
    expect(
      () =>
        new SkillCatalogReadService(db, {
          builtinSkills: [{ ...builtin, secret: 'must-not-enter-runtime' } as never],
        }),
    ).toThrow();
    expect(
      () =>
        new SkillCatalogReadService(db, {
          builtinSkills: [
            ...Array.from({ length: 100 }, () => builtin),
            { ...builtin, secret: 'secret-in-item-101' } as never,
          ],
        }),
    ).toThrow();
  });

  it('fails closed on unique-cursor pagination and aggregate item growth attacks', async () => {
    let page = 0;
    const uniqueCursorModel = {
      listPublished: async () => ({
        builtinOverrideTombstones: [],
        items: [],
        nextCursor: `unique-${page++}`,
      }),
      resolvePublishedVersion: async () => undefined,
    };
    await expect(
      new SkillCatalogReadService(db, { model: uniqueCursorModel }).getPublishedCatalog(),
    ).rejects.toThrow('page limit');
    expect(page).toBe(100);

    const oversizedModel = {
      listPublished: async () => ({
        builtinOverrideTombstones: [],
        items: Array.from({ length: 10_001 }, () => ({}) as never),
        nextCursor: null,
      }),
      resolvePublishedVersion: async () => undefined,
    };
    await expect(
      new SkillCatalogReadService(db, { model: oversizedModel }).getPublishedCatalog(),
    ).rejects.toThrow('item limit');
  });

  it('reuses the revision projection until explicit publication invalidation', async () => {
    await publish({ skillKey: 'cached.skill', version: '1.0.0' });
    const model = new PlatformSkillCatalogModel(db);
    const listPublished = vi.spyOn(model, 'listPublished');

    const first = new SkillCatalogReadService(db, { model });
    const second = new SkillCatalogReadService(db, { model });
    const firstCatalog = await first.getPublishedCatalog();
    const secondCatalog = await second.getPublishedCatalog();
    expect(secondCatalog).toEqual(firstCatalog);
    expect(listPublished).toHaveBeenCalledTimes(1);

    invalidatePublishedSkillCatalogReadCache();
    await new SkillCatalogReadService(db, { model }).getPublishedCatalog();
    expect(listPublished).toHaveBeenCalledTimes(2);
  });

  it('reports only a new execution-ready runtime projection with the exact target token', async () => {
    await publish({ contentRef: null, skillKey: 'runtime.skill', version: '1.0.0' });
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const service = new SkillCatalogReadService(db, {
      runtimeReporting: { database: db, reporter: reportRuntimeState },
    });

    await service.getPublishedCatalog();
    await service.getPublishedCatalog();
    const target = await new PlatformDomainTargetResolver(db, {
      env: { ENABLE_PLATFORM_MANAGED_SKILLS: '1' },
      loadBuiltinSkillTokenEntries: () => [],
    }).resolve('skill_catalog');

    expect(reportRuntimeState).toHaveBeenCalledOnce();
    expect(reportRuntimeState.mock.calls[0]?.[1]).toEqual({
      domain: 'skill_catalog',
      health: 'healthy',
      revisionId: target.token?.value,
      source: 'database',
    });
    expect(JSON.stringify(reportRuntimeState.mock.calls.map(([, state]) => state))).not.toContain(
      'runtime.skill',
    );
  });

  it('reports a changed active token after publication invalidation', async () => {
    const { skill } = await publish({
      contentRef: null,
      skillKey: 'changing.skill',
      version: '1.0.0',
    });
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const service = new SkillCatalogReadService(db, {
      runtimeReporting: { database: db, reporter: reportRuntimeState },
    });
    await service.getPublishedCatalog();

    await publish({
      contentRef: null,
      revision: 2,
      skillId: skill.id,
      skillKey: 'changing.skill',
      version: '2.0.0',
    });
    invalidatePublishedSkillCatalogReadCache();
    await service.getPublishedCatalog();

    const revisionIds = reportRuntimeState.mock.calls.flatMap(([, state]) =>
      state.health === 'healthy' ? [state.revisionId] : [],
    );
    expect(revisionIds).toHaveLength(2);
    expect(revisionIds[1]).not.toBe(revisionIds[0]);
  });

  it('coalesces a runtime cold load and ignores an old-epoch late failure', async () => {
    await publish({ contentRef: null, skillKey: 'singleflight.skill', version: '1.0.0' });
    const page = await new PlatformSkillCatalogModel(db).listPublished();
    const oldRead = deferred<typeof page>();
    const newRead = deferred<typeof page>();
    const listPublished = vi
      .fn<() => Promise<typeof page>>()
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(newRead.promise);
    const model = { listPublished, resolvePublishedVersion: vi.fn(async () => undefined) };
    let epoch = 'old';
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const service = new SkillCatalogReadService(db, {
      getCacheEpoch: async () => epoch,
      model,
      runtimeReporting: { database: db, reporter: reportRuntimeState },
    });

    const oldRequest = service.getPublishedCatalog();
    const coalesced = service.getPublishedCatalog();
    await vi.waitFor(() => expect(listPublished).toHaveBeenCalledOnce());
    epoch = 'new';
    const currentRequest = service.getPublishedCatalog();
    await vi.waitFor(() => expect(listPublished).toHaveBeenCalledTimes(2));
    newRead.resolve(page);
    await expect(currentRequest).resolves.toMatchObject({
      skills: [expect.objectContaining({ skillKey: 'singleflight.skill' })],
    });

    const oldError = new Error('late old Skill catalog failure');
    const oldResults = Promise.all([
      expect(oldRequest).rejects.toBe(oldError),
      expect(coalesced).rejects.toBe(oldError),
    ]);
    oldRead.reject(oldError);
    await oldResults;

    expect(reportRuntimeState.mock.calls.map(([, state]) => state.health)).toEqual(['healthy']);
    await expect(service.getPublishedCatalog()).resolves.toMatchObject({
      skills: [expect.objectContaining({ skillKey: 'singleflight.skill' })],
    });
    expect(listPublished).toHaveBeenCalledTimes(2);
  });

  it('reports a current load failure then rebuilds the same active token', async () => {
    await publish({ contentRef: null, skillKey: 'recovery.skill', version: '1.0.0' });
    const page = await new PlatformSkillCatalogModel(db).listPublished();
    const original = Object.assign(new Error('raw Skill database detail'), {
      code: 'ECONNREFUSED',
    });
    const listPublished = vi
      .fn<() => Promise<typeof page>>()
      .mockRejectedValueOnce(original)
      .mockResolvedValueOnce(page);
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const service = new SkillCatalogReadService(db, {
      model: { listPublished, resolvePublishedVersion: vi.fn(async () => undefined) },
      runtimeReporting: { database: db, reporter: reportRuntimeState },
    });

    await expect(service.getPublishedCatalog()).rejects.toBe(original);
    await service.getPublishedCatalog();

    expect(reportRuntimeState.mock.calls.map(([, state]) => state.health)).toEqual([
      'unavailable',
      'healthy',
    ]);
    expect(JSON.stringify(reportRuntimeState.mock.calls.map(([, state]) => state))).not.toContain(
      'raw Skill database detail',
    );
  });

  it('reports a stored but execution-incomplete projection as unavailable', async () => {
    await publish({ skillKey: 'external-content.skill', version: '1.0.0' });
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();

    await new SkillCatalogReadService(db, {
      runtimeReporting: { database: db, reporter: reportRuntimeState },
    }).getPublishedCatalog();

    expect(reportRuntimeState.mock.calls.map(([, state]) => state)).toEqual([
      {
        domain: 'skill_catalog',
        errorCategory: 'configuration_invalid',
        health: 'unavailable',
        source: 'unavailable',
      },
    ]);
  });

  it('contains reporter failure and historical exact resolution does not move active state', async () => {
    const { skill, version: v1 } = await publish({
      contentRef: null,
      skillKey: 'historical.runtime',
      version: '1.0.0',
    });
    await publish({
      contentRef: null,
      revision: 2,
      skillId: skill.id,
      skillKey: 'historical.runtime',
      version: '2.0.0',
    });
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>(() => {
      throw new Error('raw Skill reporter detail');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new SkillCatalogReadService(db, {
      runtimeReporting: { database: db, reporter: reportRuntimeState },
    });

    await service.getPublishedCatalog();
    await expect(
      service.resolvePinnedForExecution({
        checksum: v1.checksum,
        skillKey: 'historical.runtime',
        version: '1.0.0',
      }),
    ).resolves.toMatchObject({ version: '1.0.0' });

    expect(reportRuntimeState).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith('[platform-instance-runtime] reporter unavailable');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('raw Skill reporter detail');
    consoleError.mockRestore();
  });

  it('invalidates a warm projection on another instance through the shared epoch', async () => {
    const { skill } = await publish({ skillKey: 'cross-instance.skill', version: '1.0.0' });
    const model = new PlatformSkillCatalogModel(db);
    const listPublished = vi.spyOn(model, 'listPublished');
    let epoch = '1';
    const options = {
      cacheTtlMs: 60_000,
      getCacheEpoch: async () => epoch,
      model,
    };
    const firstInstance = new SkillCatalogReadService(db, options);
    await expect(firstInstance.getPublishedCatalog()).resolves.toMatchObject({
      skills: [expect.objectContaining({ version: '1.0.0' })],
    });

    await publish({
      revision: 2,
      skillId: skill.id,
      skillKey: 'cross-instance.skill',
      version: '2.0.0',
    });
    epoch = '2';
    const secondInstance = new SkillCatalogReadService(db, options);

    await expect(secondInstance.getPublishedCatalog()).resolves.toMatchObject({
      skills: [expect.objectContaining({ version: '2.0.0' })],
    });
    expect(listPublished).toHaveBeenCalledTimes(2);
  });

  it('bounds a warm projection when the epoch reader is unavailable', async () => {
    await publish({ skillKey: 'ttl.skill', version: '1.0.0' });
    const model = new PlatformSkillCatalogModel(db);
    const listPublished = vi.spyOn(model, 'listPublished');
    let now = 1_000;
    const options = {
      cacheTtlMs: 100,
      getCacheEpoch: async () => {
        throw new Error('redis unavailable');
      },
      model,
      now: () => now,
    };
    await new SkillCatalogReadService(db, options).getPublishedCatalog();
    await new SkillCatalogReadService(db, options).getPublishedCatalog();
    expect(listPublished).toHaveBeenCalledTimes(1);

    now += 101;
    await new SkillCatalogReadService(db, options).getPublishedCatalog();
    expect(listPublished).toHaveBeenCalledTimes(2);
  });

  it('rejects a final catalog over 10,000 after builtin merging', async () => {
    await publish({ skillKey: 'seed.skill', version: '1.0.0' });
    const page = await new PlatformSkillCatalogModel(db).listPublished({ limit: 1 });
    const seed = page.items[0]!;
    const model = {
      listPublished: vi.fn(async () => ({
        builtinOverrideTombstones: [],
        items: Array.from({ length: 10_000 }, (_, index) => ({
          ...seed,
          skillKey: `uploaded-${String(index).padStart(5, '0')}`,
        })),
        nextCursor: null,
      })),
      resolvePublishedVersion: vi.fn(async () => undefined),
    };
    const builtin: BuiltinSkillDefinition = {
      checksum: 'b'.repeat(64),
      content: '# builtin',
      description: 'Builtin',
      displayName: 'Builtin',
      distribution: 'default',
      manifest,
      skillKey: 'builtin.extra',
      source: 'builtin',
      version: '1.0.0',
    };

    await expect(
      new SkillCatalogReadService(db, { builtinSkills: [builtin], model }).getPublishedCatalog(),
    ).rejects.toThrow('after builtin merge');
  });

  // SKILL-EXACT (M10 PR-049): the pinned Skill runtime snapshot must inject the EXACT historical
  // version's content into the runtime, even after a newer version becomes the catalog head.
  describe('resolvePinnedPlatformSkillRuntimeSnapshot exact historical (SKILL-EXACT)', () => {
    const flags = { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_SKILLS: true };
    const identity = { agentId: 'agent-1', operationId: 'op-1', userId: 'user-1' };

    it('resolves the pinned v1 content after v2 is published (head moved forward)', async () => {
      const { skill, version: v1 } = await publish({
        revision: 1,
        skillKey: 'research.exact',
        version: '1.0.0',
      });
      // Publish v2 on the same Skill — the catalog head advances to v2.
      await publish({
        revision: 2,
        skillId: skill.id,
        skillKey: 'research.exact',
        version: '2.0.0',
      });

      const snapshot = await resolvePinnedPlatformSkillRuntimeSnapshot({
        db,
        flags,
        identity,
        // Real DB-backed catalog service (uploaded skills need no builtin registry); only the JWT
        // signer is stubbed (no signing key in tests).
        options: {
          catalogService: new SkillCatalogReadService(db),
          signProof: vi.fn().mockResolvedValue('pinned-proof'),
        },
        pinnedSkills: [{ checksum: v1.checksum, skillKey: 'research.exact', version: '1.0.0' }],
      });

      expect(snapshot.catalog.refs).toEqual([
        { checksum: v1.checksum, skillKey: 'research.exact', version: '1.0.0' },
      ]);
      const [skillMeta] = snapshot.skills;
      expect(skillMeta.activated).toBe(true);
      // The model activates v1's historical content, NOT the v2 head.
      expect(skillMeta.content).toContain('# 1.0.0');
      expect(skillMeta.content).not.toContain('# 2.0.0');
    });

    it('fails closed on a checksum mismatch for a pinned Skill (tampered ref)', async () => {
      await publish({ revision: 1, skillKey: 'research.exact', version: '1.0.0' });
      await expect(
        resolvePinnedPlatformSkillRuntimeSnapshot({
          db,
          flags,
          identity,
          options: {
            catalogService: new SkillCatalogReadService(db),
            signProof: vi.fn().mockResolvedValue('pinned-proof'),
          },
          // Real published version exists, but the pinned checksum is wrong → exact resolution
          // returns undefined → fail closed.
          pinnedSkills: [
            { checksum: 'f'.repeat(64), skillKey: 'research.exact', version: '1.0.0' },
          ],
        }),
      ).rejects.toThrow();
    });
  });
});
