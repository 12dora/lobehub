// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  platformAgents,
  platformAgentVersions,
  platformAuditLogs,
  platformResourceRevisions,
  platformSkills,
  platformSkillVersions,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformRevisionModel } from '../platform/revision';
import {
  createPlatformSkillPointerAdapter,
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
      ${platformAuditLogs},
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

  it('atomically publishes immutable projection and isolates it from later draft edits', async () => {
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
    await new PlatformRevisionModel(serverDB).publishDraft({
      actorUserId: 'admin-1',
      expectedRevision: 0,
      payload: {},
      pointer: createPlatformSkillPointerAdapter({
        actorUserId: 'admin-1',
        expectedDraftToken: (await model.getDetail(created.draft.id))!.draftToken,
        skillId: created.draft.id,
        versionId: version!.id,
      }),
      reason: 'publish reviewed skill',
      resourceId: created.draft.id,
      resourceType: 'skill',
    });
    expect((await model.listPublished()).items[0]).toMatchObject({
      displayName: 'Published name',
      distribution: 'default',
      revision: 1,
      version: { id: version!.id },
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
    expect((await model.listPublished()).items[0]).toMatchObject({
      displayName: 'Published name',
      distribution: 'default',
      revision: 1,
      version: { id: version!.id },
    });
    expect(await model.resolvePublishedVersion('published')).toMatchObject({
      displayName: 'Published name',
      distribution: 'default',
      version: { id: version!.id },
    });
  });

  it('atomically rolls the pointer and published projection back to a prior revision', async () => {
    const created = await model.createSkill({
      displayName: 'First name',
      enabled: true,
      skillKey: 'rollback',
    });
    const createVersion = async (content: string, version: string) => {
      const detail = (await model.getDetail(created.draft.id))!;
      return model.createVersion({
        checksum: platformSkillVersionChecksum({ content, manifest }),
        content,
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        manifest,
        skillId: created.draft.id,
        version,
      });
    };
    const publish = async (versionId: string, reason: string) => {
      const detail = (await model.getDetail(created.draft.id))!;
      return new PlatformRevisionModel(serverDB).publishDraft({
        expectedRevision: detail.baseRevision,
        payload: {},
        pointer: createPlatformSkillPointerAdapter({
          expectedDraftToken: detail.draftToken,
          skillId: created.draft.id,
          versionId,
        }),
        reason,
        resourceId: created.draft.id,
        resourceType: 'skill',
      });
    };

    const first = (await createVersion('# first', '1.0.0'))!;
    await publish(first.id, 'publish first');
    const beforeEdit = (await model.getDetail(created.draft.id))!;
    await model.updateDraft({
      displayName: 'Second name',
      enabled: true,
      expectedDraftToken: beforeEdit.draftToken,
      expectedRevision: beforeEdit.baseRevision,
      id: created.draft.id,
    });
    const second = (await createVersion('# second', '2.0.0'))!;
    await publish(second.id, 'publish second');
    const beforeRollback = (await model.getDetail(created.draft.id))!;
    await new PlatformRevisionModel(serverDB).rollbackToRevision({
      expectedRevision: 2,
      pointer: createPlatformSkillPointerAdapter({
        expectedDraftToken: beforeRollback.draftToken,
        skillId: created.draft.id,
        versionId: second.id,
      }),
      reason: 'rollback reviewed skill',
      resourceId: created.draft.id,
      resourceType: 'skill',
      targetRevision: 1,
    });

    expect(await model.getDetail(created.draft.id)).toMatchObject({
      baseRevision: 3,
      draft: { currentVersionId: first.id },
    });
    expect((await model.listPublished()).items).toEqual([
      expect.objectContaining({
        displayName: 'First name',
        version: expect.objectContaining({ id: first.id }),
      }),
    ]);
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
