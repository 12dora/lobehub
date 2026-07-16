// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { checksumPayload } from '../../models/platform/checksum';
import {
  platformAgents,
  platformAgentVersions,
  platformSkills,
  platformSkillVersions,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformSkillCatalogRepository } from '.';

const serverDB: LobeChatDatabase = await getTestDB();
const repository = new PlatformSkillCatalogRepository(serverDB);

const manifest = {
  description: 'Search internal sources',
  displayName: 'Internal search',
  localizedDescriptions: {},
  localizedDisplayNames: {},
  permissions: {
    filesystem: 'none' as const,
    network: { allowedHosts: [], enabled: false },
    tools: { allow: [] },
  },
  skillDependencies: [],
  toolDependencies: [{ optional: false, toolKey: 'builtin.search' }],
};

const cleanup = async () => {
  await serverDB.execute(sql`
    TRUNCATE TABLE
      ${platformAgentVersions},
      ${platformAgents},
      ${platformSkillVersions},
      ${platformSkills}
    CASCADE
  `);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformSkillCatalogRepository', () => {
  it('enforces stable key/version uniqueness and cursor-paginates filtered identities', async () => {
    const alpha = await repository.createSkill({
      enabled: true,
      name: 'Alpha Search',
      skillKey: 'alpha.search',
      status: 'draft',
    });
    await expect(
      repository.createSkill({ name: 'Duplicate', skillKey: 'alpha.search' }),
    ).rejects.toThrow();
    await repository.createSkill({ name: 'Charlie', skillKey: 'charlie', status: 'archived' });
    await repository.createSkill({
      enabled: true,
      name: 'Bravo Search',
      skillKey: 'bravo.search',
      status: 'draft',
    });

    const first = await repository.listSkills({ enabled: true, limit: 1, query: 'search' });
    expect(first.items.map((item) => item.skillKey)).toEqual(['alpha.search']);
    expect(first.nextCursor).toBe('alpha.search');
    const second = await repository.listSkills({
      cursor: first.nextCursor!,
      enabled: true,
      limit: 1,
      query: 'search',
    });
    expect(second.items.map((item) => item.skillKey)).toEqual(['bravo.search']);

    const values = {
      checksum: checksumPayload({ content: '# v1', manifest }),
      content: '# v1',
      manifest,
      skillId: alpha.id,
      version: '1.0.0',
    };
    await repository.createVersion(values);
    await expect(repository.createVersion(values)).rejects.toThrow();
  });

  it('makes version rows immutable at the database boundary', async () => {
    const skill = await repository.createSkill({ name: 'Stable', skillKey: 'stable' });
    const version = await repository.createVersion({
      checksum: checksumPayload({ content: '# stable', manifest }),
      content: '# stable',
      manifest,
      skillId: skill.id,
      version: '1.0.0',
    });

    await expect(
      serverDB
        .update(platformSkillVersions)
        .set({ content: '# tampered' })
        .where(sql`${platformSkillVersions.id} = ${version.id}`),
    ).rejects.toThrow();
    expect((await repository.getVersion(skill.id, version.id))?.content).toBe('# stable');
    await expect(
      serverDB
        .delete(platformSkillVersions)
        .where(sql`${platformSkillVersions.id} = ${version.id}`),
    ).rejects.toThrow();
    expect(await repository.getVersion(skill.id, version.id)).toBeDefined();
    await expect(
      serverDB.delete(platformSkills).where(sql`${platformSkills.id} = ${skill.id}`),
    ).rejects.toThrow();
  });

  it('resolves the published pointer while retaining explicit historical versions', async () => {
    const skill = await repository.createSkill({
      enabled: true,
      name: 'Search',
      skillKey: 'search',
    });
    const v1 = await repository.createVersion({
      checksum: checksumPayload({ content: '# v1', manifest }),
      content: '# v1',
      manifest,
      skillId: skill.id,
      version: '1.0.0',
    });
    const v2 = await repository.createVersion({
      checksum: checksumPayload({ content: '# v2', manifest }),
      content: '# v2',
      manifest,
      skillId: skill.id,
      version: '2.0.0',
    });
    await repository.updateSkill(skill.id, {
      currentVersionId: v2.id,
      enabled: true,
      status: 'published',
    });

    expect((await repository.resolveVersion('search'))?.version.version).toBe('2.0.0');
    await repository.updateSkill(skill.id, { status: 'archived' });
    expect(await repository.resolveVersion('search')).toBeUndefined();
    expect((await repository.resolveVersion('search', '1.0.0'))?.version.id).toBe(v1.id);
  });

  it('finds only published Skill and Agent dependents for a pinned version', async () => {
    const dependency = await repository.createSkill({ name: 'Base', skillKey: 'base' });
    await repository.createVersion({
      checksum: checksumPayload({ content: '# base', manifest }),
      content: '# base',
      manifest,
      skillId: dependency.id,
      version: '1.0.0',
    });
    const dependent = await repository.createSkill({
      name: 'Dependent',
      skillKey: 'dependent',
      status: 'published',
    });
    const dependentManifest = {
      ...manifest,
      skillDependencies: [{ optional: false, skillKey: 'base', version: '1.0.0' }],
    };
    await repository.createVersion({
      checksum: checksumPayload({ content: '# dependent', manifest: dependentManifest }),
      content: '# dependent',
      manifest: dependentManifest,
      skillId: dependent.id,
      version: '2.0.0',
    });
    const [agent] = await serverDB
      .insert(platformAgents)
      .values({ agentKey: 'helper', status: 'published', title: 'Helper' })
      .returning();
    await serverDB.insert(platformAgentVersions).values({
      agentId: agent.id,
      config: { skills: [{ skillKey: 'base', version: '1.0.0' }] },
      version: '3.0.0',
    });

    expect(await repository.getDependents('base', '1.0.0')).toEqual([
      expect.objectContaining({ key: 'helper', type: 'agent', version: '3.0.0' }),
      expect.objectContaining({ key: 'dependent', type: 'skill', version: '2.0.0' }),
    ]);
    expect(await repository.getDependents('base', '9.0.0')).toEqual([]);
  });
});
