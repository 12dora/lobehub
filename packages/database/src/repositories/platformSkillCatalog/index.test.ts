// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { checksumPayload } from '../../models/platform/checksum';
import {
  platformAgents,
  platformAgentVersions,
  platformResourceRevisions,
  platformSkills,
  platformSkillVersions,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformAgentCatalogRepository } from '../platformAgentCatalog';
import { PlatformSkillCatalogRepository } from '.';

const serverDB: LobeChatDatabase = await getTestDB();
const repository = new PlatformSkillCatalogRepository(serverDB);
const agentRepository = new PlatformAgentCatalogRepository(serverDB);
const AGENT_DEPENDENCY_CHECKSUM = 'a'.repeat(64);
const agentDependencySnapshot = {
  connectors: [],
  model: {
    modelKey: 'test-model',
    providerChecksum: AGENT_DEPENDENCY_CHECKSUM,
    providerKey: 'test-provider',
    providerRevision: 1,
  },
  skills: [{ checksum: AGENT_DEPENDENCY_CHECKSUM, skillKey: 'base', version: '1.0.0' }],
};
const agentConfig = {
  avatar: null,
  backgroundColor: null,
  description: 'M10 exact dependent',
  displayName: 'M10 exact dependent',
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: 'Use the exact dependency snapshot.',
  tags: [],
};

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

const publishedPayload = (versionId: string, overrides: Record<string, unknown> = {}) => ({
  skill: {
    allowBuiltinOverride: false,
    description: 'Published description',
    displayName: 'Published name',
    distribution: 'default',
    enabled: true,
    skillKey: 'search',
    source: 'uploaded',
    ...overrides,
  },
  versionId,
});

const createExactAgentVersion = async (params: {
  agentId: string;
  expectedDraftSequence: number;
  expectedRevision: number;
  version: string;
}) =>
  agentRepository.appendVersionCas({
    ...params,
    config: agentConfig,
    dependencySnapshot: agentDependencySnapshot,
  });

const createPublishedAgentDependent = async (agentKey: string, version: string) => {
  const agent = await agentRepository.createIdentity({
    agentKey,
    isDefault: false,
    systemKey: null,
  });
  const exactVersion = await createExactAgentVersion({
    agentId: agent.id,
    expectedDraftSequence: 0,
    expectedRevision: 0,
    version,
  });
  await agentRepository.pointToVersionCas({
    agentId: agent.id,
    expectedDraftSequence: 1,
    expectedRevision: 0,
    publishedAt: new Date(),
    versionId: exactVersion!.id,
  });
  return { agent, version: exactVersion };
};

const cleanup = async () => {
  await serverDB.execute(sql`
    TRUNCATE TABLE
      ${platformAgentVersions},
      ${platformAgents},
      ${platformResourceRevisions},
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
    const unpublished = await repository.createVersion({
      checksum: checksumPayload({ content: '# v3', manifest }),
      content: '# v3',
      manifest,
      skillId: skill.id,
      version: '3.0.0',
    });
    await serverDB.insert(platformResourceRevisions).values({
      checksum: 'published-v1',
      payload: publishedPayload(v1.id),
      resourceId: skill.id,
      resourceType: 'skill',
      revision: 1,
      status: 'published',
    });
    await serverDB.insert(platformResourceRevisions).values({
      checksum: 'published-v2',
      payload: publishedPayload(v2.id),
      resourceId: skill.id,
      resourceType: 'skill',
      revision: 2,
      status: 'published',
    });
    await repository.updateSkill(skill.id, {
      currentVersionId: v2.id,
      enabled: true,
      revision: 2,
      status: 'published',
    });

    expect((await repository.resolveVersion('search'))?.version.version).toBe('2.0.0');
    expect(
      (await repository.getPublishedExecutionVersionExact('search', '1.0.0'))?.version.id,
    ).toBe(v1.id);
    await repository.updateSkill(skill.id, { enabled: false });
    expect(await repository.getPublishedExecutionVersionExact('search', '1.0.0')).toBeUndefined();
    await repository.updateSkill(skill.id, { enabled: true });

    await serverDB.insert(platformResourceRevisions).values({
      checksum: 'disabled-v3',
      payload: publishedPayload(unpublished.id, { enabled: false }),
      resourceId: skill.id,
      resourceType: 'skill',
      revision: 3,
      status: 'published',
    });
    expect(
      await repository.getPublishedExecutionVersionExact('search', unpublished.version),
    ).toBeUndefined();

    await serverDB.insert(platformResourceRevisions).values({
      checksum: 'archived-v2',
      payload: publishedPayload(v2.id),
      resourceId: skill.id,
      resourceType: 'skill',
      revision: 4,
      status: 'archived',
    });
    await repository.updateSkill(skill.id, { revision: 4, status: 'archived' });
    expect(await repository.resolveVersion('search')).toBeUndefined();
    expect((await repository.resolveVersion('search', '1.0.0'))?.version.id).toBe(v1.id);
    expect(await repository.getPublishedExecutionVersionExact('search', '1.0.0')).toBeUndefined();
    expect((await repository.resolveVersion('search', unpublished.version))?.version.id).toBe(
      unpublished.id,
    );
  });

  it('cursor-paginates only current immutable published snapshots with same-Skill versions', async () => {
    let foreignVersionId = '';
    for (const [index, skillKey] of ['alpha', 'bravo', 'charlie'].entries()) {
      const skill = await repository.createSkill({
        enabled: false,
        name: `Mutable ${skillKey}`,
        skillKey,
        status: 'draft',
      });
      const version = await repository.createVersion({
        checksum: checksumPayload({ content: `# ${skillKey}`, manifest }),
        content: `# ${skillKey}`,
        manifest,
        skillId: skill.id,
        version: '1.0.0',
      });
      if (skillKey === 'alpha') foreignVersionId = version.id;
      await serverDB.insert(platformResourceRevisions).values({
        checksum: `published-${skillKey}`,
        payload: publishedPayload(version.id, {
          displayName: `Published ${skillKey}`,
          enabled: index !== 2,
          skillKey,
        }),
        resourceId: skill.id,
        resourceType: 'skill',
        revision: 1,
        status: 'published',
      });
      await repository.updateSkill(skill.id, {
        currentVersionId: version.id,
        revision: 1,
        status: 'published',
      });
    }
    const mismatched = await repository.createSkill({ name: 'Mismatched', skillKey: 'mismatched' });
    const ownVersion = await repository.createVersion({
      checksum: checksumPayload({ content: '# own', manifest }),
      content: '# own',
      manifest,
      skillId: mismatched.id,
      version: '1.0.0',
    });
    await serverDB.insert(platformResourceRevisions).values({
      checksum: 'mismatched-version',
      payload: publishedPayload(foreignVersionId, { skillKey: 'mismatched' }),
      resourceId: mismatched.id,
      resourceType: 'skill',
      revision: 1,
      status: 'published',
    });
    await repository.updateSkill(mismatched.id, {
      currentVersionId: ownVersion.id,
      revision: 1,
      status: 'published',
    });

    const first = await repository.listPublished({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.payload.skill).toMatchObject({
      displayName: 'Published alpha',
      enabled: true,
      skillKey: 'alpha',
    });
    expect(first.nextCursor).toBe('alpha');
    const second = await repository.listPublished({ cursor: first.nextCursor!, limit: 1 });
    expect(second.items[0]?.payload.skill.skillKey).toBe('bravo');
    expect(second.nextCursor).toBeNull();
  });

  it('enforces same-Skill published pointers and a non-null published version', async () => {
    const alpha = await repository.createSkill({ name: 'Alpha', skillKey: 'alpha' });
    const beta = await repository.createSkill({ name: 'Beta', skillKey: 'beta' });
    const version = await repository.createVersion({
      checksum: checksumPayload({ content: '# alpha', manifest }),
      content: '# alpha',
      manifest,
      skillId: alpha.id,
      version: '1.0.0',
    });
    await expect(
      repository.updateSkill(beta.id, { currentVersionId: version.id, status: 'published' }),
    ).rejects.toThrow();
    await expect(repository.updateSkill(beta.id, { status: 'published' })).rejects.toThrow();
    await expect(
      repository.updateSkill(alpha.id, { currentVersionId: version.id, status: 'published' }),
    ).resolves.toMatchObject({ currentVersionId: version.id, status: 'published' });
  });

  it('cursor-paginates immutable version metadata with database-side limits', async () => {
    const skill = await repository.createSkill({ name: 'Paged', skillKey: 'paged' });
    for (let index = 0; index < 4; index += 1) {
      await repository.createVersion({
        checksum: checksumPayload({ content: `# v${index}`, manifest }),
        content: `# v${index}`,
        createdAt: new Date(`2026-01-0${index + 1}T00:00:00Z`),
        manifest,
        skillId: skill.id,
        version: `1.0.${index}`,
      });
    }
    const first = await repository.listVersionPage({ limit: 2, skillId: skill.id });
    expect(first.items.map((item) => item.version)).toEqual(['1.0.3', '1.0.2']);
    expect(first.nextCursor).not.toBeNull();
    const second = await repository.listVersionPage({
      cursor: first.nextCursor!,
      limit: 2,
      skillId: skill.id,
    });
    expect(second.items.map((item) => item.version)).toEqual(['1.0.1', '1.0.0']);
    expect(second.nextCursor).toBeNull();
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
    const dependent = await repository.createSkill({ name: 'Dependent', skillKey: 'dependent' });
    const dependentManifest = {
      ...manifest,
      skillDependencies: [{ optional: false, skillKey: 'base', version: '1.0.0' }],
    };
    const dependentVersion = await repository.createVersion({
      checksum: checksumPayload({ content: '# dependent', manifest: dependentManifest }),
      content: '# dependent',
      manifest: dependentManifest,
      skillId: dependent.id,
      version: '2.0.0',
    });
    await repository.updateSkill(dependent.id, {
      currentVersionId: dependentVersion.id,
      enabled: true,
      status: 'published',
    });
    const { agent } = await createPublishedAgentDependent('helper', '3.0.0');

    expect(
      (await repository.getDependentsPage({ skillKey: 'base', version: '1.0.0' })).items,
    ).toEqual([
      expect.objectContaining({ key: 'helper', type: 'agent', version: '3.0.0' }),
      expect.objectContaining({ key: 'dependent', type: 'skill', version: '2.0.0' }),
    ]);
    expect(
      (await repository.getDependentsPage({ skillKey: 'base', version: '9.0.0' })).items,
    ).toEqual([]);

    const unpublishedSkillVersion = await repository.createVersion({
      checksum: checksumPayload({ content: '# unpublished', manifest: dependentManifest }),
      content: '# unpublished',
      manifest: dependentManifest,
      skillId: dependent.id,
      version: '2.1.0',
    });
    const unpublishedAgentVersion = await createExactAgentVersion({
      agentId: agent.id,
      expectedDraftSequence: 2,
      expectedRevision: 1,
      version: '3.1.0',
    });
    expect(
      (await repository.getDependentsPage({ skillKey: 'base', version: '1.0.0' })).items.map(
        (item) => item.id,
      ),
    ).not.toEqual(
      expect.arrayContaining([unpublishedSkillVersion.id, unpublishedAgentVersion!.id]),
    );

    await serverDB.insert(platformResourceRevisions).values([
      {
        checksum: 'dependent-provenance',
        payload: { versionId: unpublishedSkillVersion.id },
        resourceId: dependent.id,
        resourceType: 'skill',
        revision: 1,
        status: 'published',
      },
      {
        checksum: 'agent-provenance',
        payload: { versionId: unpublishedAgentVersion!.id },
        resourceId: agent.id,
        resourceType: 'agent',
        revision: 1,
        status: 'published',
      },
    ]);
    expect(
      (await repository.getDependentsPage({ skillKey: 'base', version: '1.0.0' })).items.map(
        (item) => item.id,
      ),
    ).toEqual(expect.arrayContaining([unpublishedSkillVersion.id, unpublishedAgentVersion!.id]));
  });

  it('cursor-paginates dependents after filtering in the database', async () => {
    for (const key of ['agent-a', 'agent-b', 'agent-c']) {
      await createPublishedAgentDependent(key, '1.0.0');
    }
    const first = await repository.getDependentsPage({ limit: 2, skillKey: 'base' });
    expect(first.items.map((item) => item.key)).toEqual(['agent-a', 'agent-b']);
    expect(first.nextCursor).not.toBeNull();
    const second = await repository.getDependentsPage({
      cursor: first.nextCursor!,
      limit: 2,
      skillKey: 'base',
    });
    expect(second.items.map((item) => item.key)).toEqual(['agent-c']);
  });
});
