// @vitest-environment node
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import * as schema from '../../schemas';
import {
  platformResourceRevisions,
  platformSkills,
  platformSkillVersions,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformSkillCatalogModel, platformSkillVersionChecksum } from '../platform/skillCatalog';

const runPostgresConcurrency = process.env.TEST_SERVER_DB === '1';

const manifest = {
  description: 'Concurrent Skill',
  displayName: 'Concurrent Skill',
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

describe.skipIf(!runPostgresConcurrency)('PlatformSkillCatalogModel PostgreSQL concurrency', () => {
  it('serializes two writers sharing one draft token so exactly one version is appended', async () => {
    await getTestDB();
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const firstPool = new Pool({ connectionString, max: 1 });
    const secondPool = new Pool({ connectionString, max: 1 });
    const firstDb = drizzle(firstPool, { schema }) as unknown as LobeChatDatabase;
    const secondDb = drizzle(secondPool, { schema }) as unknown as LobeChatDatabase;
    const cleanup = async () => {
      await firstPool.query(
        'TRUNCATE TABLE platform_resource_revisions, platform_skill_versions, platform_skills CASCADE',
      );
    };

    try {
      await cleanup();
      const firstModel = new PlatformSkillCatalogModel(firstDb);
      const secondModel = new PlatformSkillCatalogModel(secondDb);
      const created = await firstModel.createSkill({
        displayName: 'Concurrent Skill',
        skillKey: 'concurrent',
      });
      const write = (model: PlatformSkillCatalogModel, version: string) => {
        const content = `# ${version}`;
        return model.createVersion({
          checksum: platformSkillVersionChecksum({ content, manifest }),
          content,
          expectedDraftToken: created.draftToken,
          expectedRevision: created.baseRevision,
          manifest,
          skillId: created.draft.id,
          version,
        });
      };

      const results = await Promise.allSettled([
        write(firstModel, '1.0.0'),
        write(secondModel, '2.0.0'),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const versions = await firstDb.select().from(platformSkillVersions);
      const [identity] = await firstDb.select().from(platformSkills);
      expect(versions).toHaveLength(1);
      expect(identity.draftSequence).toBe(1);
    } finally {
      await cleanup();
      await firstDb.delete(platformResourceRevisions);
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  }, 15_000);
});
