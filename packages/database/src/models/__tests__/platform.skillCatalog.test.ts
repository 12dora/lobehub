// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  platformAgents,
  platformAgentVersions,
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
      allowed.createSkill({ displayName: 'Override', skillKey: 'builtin.search' }),
    ).resolves.toMatchObject({ draft: { skillKey: 'builtin.search' } });
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
    expect(updated?.versions).toEqual([expect.objectContaining({ content: '# v1' })]);
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
