// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformSkillVersionChecksum } from '@/database/models/platform';
import { PlatformSkillCatalogRepository } from '@/database/repositories/platformSkillCatalog';
import {
  platformResourceRevisions,
  platformSkills,
  platformSkillVersions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { SkillManifest } from '../../contracts/skillCatalog';
import { type BuiltinSkillDefinition, SkillCatalogReadService } from './readService';

const db: LobeChatDatabase = await getTestDB();

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
    checksum: platformSkillVersionChecksum({ content, manifest, resources }),
    content,
    contentRef: 'opaque:skill-content-1',
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
      listPublished: async () => ({ items: [], nextCursor: `unique-${page++}` }),
      resolvePublishedVersion: async () => undefined,
    };
    await expect(
      new SkillCatalogReadService(db, { model: uniqueCursorModel }).getPublishedCatalog(),
    ).rejects.toThrow('page limit');
    expect(page).toBe(100);

    const oversizedModel = {
      listPublished: async () => ({
        items: Array.from({ length: 10_001 }, () => ({}) as never),
        nextCursor: null,
      }),
      resolvePublishedVersion: async () => undefined,
    };
    await expect(
      new SkillCatalogReadService(db, { model: oversizedModel }).getPublishedCatalog(),
    ).rejects.toThrow('item limit');
  });
});
