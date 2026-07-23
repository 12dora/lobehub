// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { checksumPayload } from '@/database/models/platform';
import { PlatformSkillCatalogRepository } from '@/database/repositories/platformSkillCatalog';
import { platformResourceRevisions } from '@/database/schemas/platform';

import { loadCurrentSkillCatalogSnapshot } from '../platformInstance/catalogAuthority';
import { PlatformCatalogTokenInvariantError } from '../platformInstance/catalogTokens';
import { PlatformDomainTargetResolver } from '../platformInstance/domainTargets';
import type { PlatformRuntimeMaterializationReporter } from '../platformInstance/runtimeReporter';
import {
  type BuiltinSkillDefinition,
  invalidatePublishedSkillCatalogReadCache,
  SkillCatalogReadService,
} from './readService';
import {
  db,
  installReadServiceTestLifecycle,
  manifest,
  publishReadServiceSkill as publish,
} from './readService.test.fixtures';

installReadServiceTestLifecycle();

describe('SkillCatalogReadService readiness / reporting', () => {
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

  it('follows a normal current-pointer rollback and keeps target/runtime tokens exact', async () => {
    const v1 = await publish({ contentRef: null, skillKey: 'rollback.skill', version: '1.0.0' });
    await publish({
      contentRef: null,
      revision: 2,
      skillId: v1.skill.id,
      skillKey: 'rollback.skill',
      version: '2.0.0',
    });
    await new PlatformSkillCatalogRepository(db).updateSkill(v1.skill.id, {
      currentVersionId: v1.version.id,
      revision: 1,
      status: 'published',
    });
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const service = new SkillCatalogReadService(db, {
      runtimeReporting: { database: db, reporter: reportRuntimeState },
    });

    const catalog = await service.getPublishedCatalog();
    const target = await new PlatformDomainTargetResolver(db, {
      env: { ENABLE_PLATFORM_MANAGED_SKILLS: '1' },
      loadBuiltinSkillTokenEntries: () => [],
    }).resolve('skill_catalog');
    expect(catalog.skills).toEqual([
      expect.objectContaining({ skillKey: 'rollback.skill', version: '1.0.0' }),
    ]);
    expect(catalog.revision).toBe(target.token?.value);
    expect(reportRuntimeState.mock.calls[0]?.[1]).toMatchObject({
      revisionId: target.token?.value,
    });
  });

  it('includes a valid builtin tombstone in the same current-pointer token', async () => {
    const builtin: BuiltinSkillDefinition = {
      checksum: 'b'.repeat(64),
      content: '# builtin',
      description: 'Builtin',
      displayName: 'Builtin',
      distribution: 'default',
      manifest,
      skillKey: 'builtin.tombstone',
      source: 'builtin',
      version: '1.0.0',
    };
    const { skill, version } = await publish({
      allowBuiltinOverride: true,
      contentRef: null,
      skillKey: builtin.skillKey,
      version: '2.0.0',
    });
    const tombstonePayload = {
      builtinOverrideTombstone: true,
      skill: {
        allowBuiltinOverride: true,
        description: 'Archived override',
        displayName: 'Archived override',
        distribution: 'default',
        enabled: true,
        skillKey: builtin.skillKey,
        source: 'uploaded',
      },
      versionId: version.id,
    } as const;
    await db.insert(platformResourceRevisions).values({
      checksum: checksumPayload(tombstonePayload),
      payload: tombstonePayload,
      resourceId: skill.id,
      resourceType: 'skill',
      revision: 2,
      status: 'archived',
    });
    await new PlatformSkillCatalogRepository(db).updateSkill(skill.id, {
      currentVersionId: version.id,
      revision: 2,
      status: 'archived',
    });
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const catalog = await new SkillCatalogReadService(db, {
      builtinSkills: [builtin],
      runtimeReporting: { database: db, reporter: reportRuntimeState },
    }).getPublishedCatalog();
    const target = await new PlatformDomainTargetResolver(db, {
      env: { ENABLE_PLATFORM_MANAGED_SKILLS: '1' },
      loadBuiltinSkillTokenEntries: () => [builtin],
    }).resolve('skill_catalog');

    expect(catalog.skills).toEqual([]);
    expect(catalog.revision).toBe(target.token?.value);
    expect((await loadCurrentSkillCatalogSnapshot(db)).tokenEntries).toEqual([
      expect.objectContaining({ skillKey: builtin.skillKey, tombstone: true }),
    ]);
    expect(reportRuntimeState.mock.calls[0]?.[1]).toMatchObject({
      revisionId: target.token?.value,
    });
  });

  it('fails a missing current revision as one catalog and recovers exactly after repair', async () => {
    const { skill } = await publish({
      contentRef: null,
      skillKey: 'broken-revision.skill',
      version: '1.0.0',
    });
    const [savedRevision] = await db
      .select()
      .from(platformResourceRevisions)
      .where(eq(platformResourceRevisions.resourceId, skill.id));
    // Simulate legacy / corrupted rows: temporarily disable immutability triggers.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx
        .delete(platformResourceRevisions)
        .where(eq(platformResourceRevisions.resourceId, skill.id));
    });
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const service = new SkillCatalogReadService(db, {
      runtimeReporting: { database: db, reporter: reportRuntimeState },
    });

    await expect(service.getPublishedCatalog()).rejects.toBeInstanceOf(
      PlatformCatalogTokenInvariantError,
    );
    await expect(
      new PlatformDomainTargetResolver(db, {
        env: { ENABLE_PLATFORM_MANAGED_SKILLS: '1' },
        loadBuiltinSkillTokenEntries: () => [],
      }).resolve('skill_catalog'),
    ).resolves.toMatchObject({ errorCategory: 'configuration_invalid', status: 'unavailable' });
    expect(reportRuntimeState.mock.calls.map(([, state]) => state.health)).toEqual(['unavailable']);

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.insert(platformResourceRevisions).values(savedRevision!);
    });
    const repairedTarget = await new PlatformDomainTargetResolver(db, {
      env: { ENABLE_PLATFORM_MANAGED_SKILLS: '1' },
      loadBuiltinSkillTokenEntries: () => [],
    }).resolve('skill_catalog');
    await service.getPublishedCatalog();
    expect(reportRuntimeState.mock.calls.map(([, state]) => state.health)).toEqual([
      'unavailable',
      'healthy',
    ]);
    expect(reportRuntimeState.mock.calls[1]?.[1]).toMatchObject({
      revisionId: repairedTarget.token?.value,
    });
  });

  it.each(['mismatch', 'missing'] as const)(
    'fails closed when the current version pointer is %s',
    async (mode) => {
      const v1 = await publish({
        contentRef: null,
        skillKey: `broken-version-${mode}.skill`,
        version: '1.0.0',
      });
      if (mode === 'mismatch') {
        const v2 = await new PlatformSkillCatalogRepository(db).createVersion({
          checksum: v1.version.checksum,
          content: v1.version.content,
          contentRef: v1.version.contentRef,
          manifest,
          resources: v1.version.resources,
          skillId: v1.skill.id,
          version: '2.0.0',
        });
        await new PlatformSkillCatalogRepository(db).updateSkill(v1.skill.id, {
          currentVersionId: v2.id,
        });
      } else {
        await new PlatformSkillCatalogRepository(db).updateSkill(v1.skill.id, {
          currentVersionId: null,
          status: 'draft',
        });
      }

      await expect(new SkillCatalogReadService(db).getPublishedCatalog()).rejects.toBeInstanceOf(
        PlatformCatalogTokenInvariantError,
      );
      await expect(
        new PlatformDomainTargetResolver(db, {
          env: { ENABLE_PLATFORM_MANAGED_SKILLS: '1' },
          loadBuiltinSkillTokenEntries: () => [],
        }).resolve('skill_catalog'),
      ).resolves.toMatchObject({ errorCategory: 'configuration_invalid', status: 'unavailable' });
    },
  );
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
  it('reports a current load failure then rebuilds the same active token', async () => {
    await publish({ contentRef: null, skillKey: 'recovery.skill', version: '1.0.0' });
    const snapshot = await loadCurrentSkillCatalogSnapshot(db);
    const original = Object.assign(new Error('raw Skill database detail'), {
      code: 'ECONNREFUSED',
    });
    const loadCurrentSnapshot = vi
      .fn<() => Promise<typeof snapshot>>()
      .mockRejectedValueOnce(original)
      .mockResolvedValueOnce(snapshot);
    const reportRuntimeState = vi.fn<PlatformRuntimeMaterializationReporter>();
    const service = new SkillCatalogReadService(db, {
      loadCurrentSnapshot,
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
});
