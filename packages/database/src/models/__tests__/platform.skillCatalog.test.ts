// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  platformAgents,
  platformAgentVersions,
  platformResourceRevisions,
  platformSkills,
  platformSkillVersions,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import {
  PlatformSkillBuiltinOverrideError,
  PlatformSkillCatalogModel,
  PlatformSkillChecksumMismatchError,
  platformSkillVersionChecksum,
} from '../platform/skillCatalog';

const serverDB: LobeChatDatabase = await getTestDB();
const model = new PlatformSkillCatalogModel(serverDB, {
  builtinSkillKeys: new Set(['builtin.search']),
});

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
  toolDependencies: [],
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

describe('PlatformSkillCatalogModel', () => {
  it('rejects builtin overrides by default and requires an explicit override option', async () => {
    await expect(
      model.createSkill({ displayName: 'Override', skillKey: 'builtin.search' }),
    ).rejects.toBeInstanceOf(PlatformSkillBuiltinOverrideError);

    const allowed = new PlatformSkillCatalogModel(serverDB, {
      allowBuiltinOverride: true,
      builtinSkillKeys: new Set(['builtin.search']),
    });
    await expect(
      allowed.createSkill({
        allowBuiltinOverride: true,
        displayName: 'Override',
        skillKey: 'builtin.search',
      }),
    ).resolves.toMatchObject({
      draft: { allowBuiltinOverride: true, skillKey: 'builtin.search', source: 'uploaded' },
    });
  });

  it('appends checksummed versions and never changes existing version content via updateDraft', async () => {
    const created = await model.createSkill({ displayName: 'Search', skillKey: 'search' });
    const checksum = platformSkillVersionChecksum({ content: '# v1', manifest });
    const version = await model.createVersion({
      checksum,
      content: '# v1',
      expectedDraftToken: created.draftToken,
      expectedRevision: created.baseRevision,
      manifest,
      skillId: created.draft.id,
      version: '1.0.0',
    });
    const afterVersion = await model.getDetail(created.draft.id);
    expect(version).toMatchObject({ checksum, content: '# v1', version: '1.0.0' });
    expect(afterVersion?.draftToken).not.toBe(created.draftToken);

    const updated = await model.updateDraft({
      displayName: 'Renamed search',
      expectedDraftToken: afterVersion!.draftToken,
      expectedRevision: afterVersion!.baseRevision,
      id: created.draft.id,
    });
    expect(updated?.draft.displayName).toBe('Renamed search');
    expect(updated?.latestVersion).toEqual(expect.objectContaining({ content: '# v1' }));
    expect(updated?.draft.draftSequence).toBe(2);
  });

  it('checksums every immutable execution field', async () => {
    const created = await model.createSkill({ displayName: 'Search', skillKey: 'search' });
    const resources = [
      {
        checksum: 'a'.repeat(64),
        content: 'resource',
        mediaType: 'text/plain',
        path: 'references/source.txt',
        sizeBytes: 8,
      },
    ];
    const payload = {
      content: '# v1',
      contentRef: 'opaque:skill-content-1',
      manifest,
      resources,
    };
    const checksum = platformSkillVersionChecksum(payload);
    await expect(
      model.createVersion({
        ...payload,
        checksum,
        expectedDraftToken: created.draftToken,
        expectedRevision: created.baseRevision,
        skillId: created.draft.id,
        version: '1.0.0',
      }),
    ).resolves.toMatchObject({ checksum, resources });

    const fresh = await model.getDetail(created.draft.id);
    const mutations = [
      { ...payload, content: '# tampered' },
      { ...payload, contentRef: 'opaque:tampered' },
      { ...payload, manifest: { ...manifest, displayName: 'Tampered' } },
      { ...payload, resources: [{ ...resources[0]!, content: 'tampered' }] },
    ];
    for (const [index, mutation] of mutations.entries()) {
      await expect(
        model.createVersion({
          ...mutation,
          checksum,
          expectedDraftToken: fresh!.draftToken,
          expectedRevision: fresh!.baseRevision,
          skillId: created.draft.id,
          version: `2.0.${index}`,
        }),
      ).rejects.toBeInstanceOf(PlatformSkillChecksumMismatchError);
    }
  });

  it('canonicalizes Unicode, line endings, locale maps, permission sets and resource order', async () => {
    const nfd = 'Cafe\u0301';
    const nfc = 'Café';
    const left = {
      content: `${nfd}\r\nline`,
      manifest: {
        ...manifest,
        displayName: nfd,
        localizedDescriptions: { 'zh-CN': '中文', 'en-US': nfd },
        permissions: {
          ...manifest.permissions,
          network: { allowedHosts: ['b.example', 'a.example'], enabled: true },
        },
      },
      resources: [
        {
          checksum: 'b'.repeat(64),
          content: 'B\r\n',
          mediaType: 'text/plain',
          path: 'b.txt',
          sizeBytes: 3,
        },
        {
          checksum: 'a'.repeat(64),
          content: `${nfd}\r`,
          mediaType: 'text/plain',
          path: 'a.txt',
          sizeBytes: 6,
        },
      ],
    };
    const right = {
      content: `${nfc}\nline`,
      manifest: {
        ...left.manifest,
        displayName: nfc,
        localizedDescriptions: { 'en-US': nfc, 'zh-CN': '中文' },
        permissions: {
          ...left.manifest.permissions,
          network: { allowedHosts: ['a.example', 'b.example'], enabled: true },
        },
      },
      resources: [
        { ...left.resources[1]!, content: `${nfc}\n` },
        { ...left.resources[0]!, content: 'B\n' },
      ],
    };
    expect(platformSkillVersionChecksum(left)).toBe(platformSkillVersionChecksum(right));

    const created = await model.createSkill({ displayName: 'Canonical', skillKey: 'canonical' });
    const version = await model.createVersion({
      ...left,
      checksum: platformSkillVersionChecksum(left),
      expectedDraftToken: created.draftToken,
      expectedRevision: 0,
      skillId: created.draft.id,
      version: '1.0.0',
    });
    expect(version?.content).toBe(`${nfc}\nline`);
    expect(version?.resources.map((resource) => resource.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('edits the draft projection without changing the published pointer or snapshot', async () => {
    const created = await model.createSkill({
      displayName: 'Published name',
      distribution: 'default',
      enabled: true,
      skillKey: 'published',
    });
    const checksum = platformSkillVersionChecksum({ content: '# v1', manifest });
    const version = await model.createVersion({
      checksum,
      content: '# v1',
      expectedDraftToken: created.draftToken,
      expectedRevision: 0,
      manifest,
      skillId: created.draft.id,
      version: '1.0.0',
    });
    await serverDB
      .update(platformSkills)
      .set({ currentVersionId: version!.id, revision: 1, status: 'published' })
      .where(sql`${platformSkills.id} = ${created.draft.id}`);
    const publishedPayload = {
      skill: {
        displayName: 'Published name',
        distribution: 'default',
        enabled: true,
      },
      versionId: version!.id,
    };
    await serverDB.insert(platformResourceRevisions).values({
      checksum: 'published-snapshot',
      payload: publishedPayload,
      resourceId: created.draft.id,
      resourceType: 'skill',
      revision: 1,
      status: 'published',
    });
    const beforeEdit = await model.getDetail(created.draft.id);
    const edited = await model.updateDraft({
      displayName: 'Draft name',
      distribution: 'mandatory',
      enabled: false,
      expectedDraftToken: beforeEdit!.draftToken,
      expectedRevision: 1,
      id: created.draft.id,
    });

    expect(edited?.draft).toMatchObject({
      currentVersionId: version!.id,
      displayName: 'Draft name',
      distribution: 'mandatory',
      enabled: false,
      revision: 1,
      status: 'published',
    });
    const [published] = await serverDB
      .select({ payload: platformResourceRevisions.payload })
      .from(platformResourceRevisions);
    expect(published.payload).toEqual(publishedPayload);
  });

  it('rejects stale draft tokens and client checksums before inserting a version', async () => {
    const created = await model.createSkill({ displayName: 'Search', skillKey: 'search' });
    await expect(
      model.createVersion({
        checksum: '0'.repeat(64),
        content: '# v1',
        expectedDraftToken: created.draftToken,
        expectedRevision: created.baseRevision,
        manifest,
        skillId: created.draft.id,
        version: '1.0.0',
      }),
    ).rejects.toBeInstanceOf(PlatformSkillChecksumMismatchError);

    const checksum = platformSkillVersionChecksum({ content: '# v1', manifest });
    await model.createVersion({
      checksum,
      content: '# v1',
      expectedDraftToken: created.draftToken,
      expectedRevision: created.baseRevision,
      manifest,
      skillId: created.draft.id,
      version: '1.0.0',
    });
    await expect(
      model.createVersion({
        checksum: platformSkillVersionChecksum({ content: '# v2', manifest }),
        content: '# v2',
        expectedDraftToken: created.draftToken,
        expectedRevision: created.baseRevision,
        manifest,
        skillId: created.draft.id,
        version: '2.0.0',
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_REVISION_CONFLICT' });
  });
});
