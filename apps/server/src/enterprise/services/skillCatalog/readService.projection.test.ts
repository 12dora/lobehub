// @vitest-environment node
import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { platformSkillVersions } from '@/database/schemas/platform';

import { loadCurrentSkillCatalogSnapshot } from '../platformInstance/catalogAuthority';
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

describe('SkillCatalogReadService projection / merge', () => {
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

  it('loads the complete strict authority set and preserves global codepoint ordering', async () => {
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

  it('skips a corrupt published skill without taking down the rest of the catalog', async () => {
    await publish({ skillKey: 'healthy.skill', version: '1.0.0' });
    const broken = await publish({ skillKey: 'broken.skill', version: '1.0.0' });
    // Stale sizeBytes after content normalization historically made serverResolvedSkillSchema
    // throw mid-projection and disable the entire managed catalog.
    await db
      .update(platformSkillVersions)
      .set({
        resources: [
          {
            checksum: 'a'.repeat(64),
            content: 'B\n',
            mediaType: 'text/plain',
            path: 'b.txt',
            sizeBytes: 3,
          },
        ],
      })
      .where(sql`${platformSkillVersions.id} = ${broken.version.id}`);
    invalidatePublishedSkillCatalogReadCache();
    const catalog = await new SkillCatalogReadService(db).getPublishedCatalog();
    expect(catalog.skills.map((skill) => skill.skillKey)).toEqual(['healthy.skill']);
    await expect(
      new SkillCatalogReadService(db).resolveForExecution('healthy.skill', '1.0.0'),
    ).resolves.toMatchObject({ skillKey: 'healthy.skill' });
    await expect(
      new SkillCatalogReadService(db).resolveForExecution('broken.skill', '1.0.0'),
    ).resolves.toBeUndefined();
  });

  it('rejects aggregate item growth only after the strict authority load completes', async () => {
    const loadCurrentSnapshot = vi.fn(async () => ({
      builtinOverrideTombstones: [],
      items: Array.from({ length: 10_001 }, () => ({}) as never),
      tokenEntries: [],
    }));
    await expect(
      new SkillCatalogReadService(db, { loadCurrentSnapshot }).getPublishedCatalog(),
    ).rejects.toThrow('item limit');
    expect(loadCurrentSnapshot).toHaveBeenCalledOnce();
  });

  it('rejects a final catalog over 10,000 after builtin merging', async () => {
    await publish({ skillKey: 'seed.skill', version: '1.0.0' });
    const snapshot = await loadCurrentSkillCatalogSnapshot(db);
    const seed = snapshot.items[0]!;
    const loadCurrentSnapshot = vi.fn(async () => ({
      builtinOverrideTombstones: [],
      items: Array.from({ length: 10_000 }, (_, index) => ({
        ...seed,
        skillKey: `uploaded-${String(index).padStart(5, '0')}`,
      })),
      tokenEntries: snapshot.tokenEntries,
    }));
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
      new SkillCatalogReadService(db, {
        builtinSkills: [builtin],
        loadCurrentSnapshot,
      }).getPublishedCatalog(),
    ).rejects.toThrow('after builtin merge');
  });
});
