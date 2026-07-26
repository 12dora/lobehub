// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { checksumPayload } from '@/database/models/platform';
import { PlatformSkillCatalogRepository } from '@/database/repositories/platformSkillCatalog';
import { platformResourceRevisions } from '@/database/schemas/platform';

import { SkillCatalogReadService } from './readService';
import {
  db,
  installReadServiceTestLifecycle,
  publishReadServiceSkill as publish,
} from './readService.test.fixtures';
import { resolvePinnedPlatformSkillRuntimeSnapshot } from './runtimeSnapshot';

installReadServiceTestLifecycle();

describe('SkillCatalogReadService historical resolution', () => {
  it('keeps an exact historical version resolvable after the current head is archived', async () => {
    const { skill, version } = await publish({ skillKey: 'historical', version: '1.0.0' });
    const archivedPayload = {
      skill: {
        allowBuiltinOverride: false,
        description: 'Immutable published description',
        displayName: 'Immutable published name',
        distribution: 'default',
        enabled: true,
        skillKey: 'historical',
        source: 'uploaded',
      },
      versionId: version.id,
    } as const;
    await db.insert(platformResourceRevisions).values({
      checksum: checksumPayload(archivedPayload),
      payload: archivedPayload,
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

  it('returns isolated pinned clones without retaining caller mutations', async () => {
    const { version } = await publish({ skillKey: 'clone.bound', version: '1.0.0' });
    const service = new SkillCatalogReadService(db);
    const ref = {
      checksum: version.checksum,
      skillKey: 'clone.bound',
      version: '1.0.0',
    };
    const first = await service.resolvePinnedForExecution(ref);
    expect(first).toBeDefined();
    first!.content = 'caller mutation';
    first!.resources[0]!.content = 'caller resource mutation';

    await expect(service.resolvePinnedForExecution(ref)).resolves.toMatchObject({
      content: '# 1.0.0',
      resources: [{ content: 'reference' }],
    });
  });

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
