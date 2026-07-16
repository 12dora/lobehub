// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PlatformModels from '@/database/models/platform';
import { PlatformManagedResourcePolicyModel } from '@/database/models/platform';
import type * as SkillCatalog from '@/server/enterprise/services/skillCatalog';
import { SkillCatalogReadService } from '@/server/enterprise/services/skillCatalog';

import { agentSkillsRouter } from '../agentSkills';

const mocks = vi.hoisted(() => ({
  getPolicySnapshot: vi.fn(),
  resolvePinnedForExecution: vi.fn(),
}));

vi.mock('@/business/server/trpc-middlewares/workspaceAuth', async () => {
  const mod = await vi.importActual<{ trpc: any }>('@/libs/trpc/lambda/init');
  return { wsCompatProcedure: mod.trpc.procedure };
});
vi.mock('@/libs/trpc/lambda/middleware', () => ({
  serverDatabase: async (opts: any) =>
    opts.next({ ctx: { ...opts.ctx, serverDB: opts.ctx.serverDB ?? {} } }),
}));
vi.mock('@/server/enterprise/featureFlags', () => ({
  parseEnterpriseFeatureFlags: () => ({ ENABLE_PLATFORM_MANAGED_SKILLS: true }),
}));
vi.mock('@/database/models/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformModels>();
  return {
    ...actual,
    PlatformManagedResourcePolicyModel: vi.fn().mockImplementation(() => ({
      getSnapshot: mocks.getPolicySnapshot,
    })),
  };
});
vi.mock('@/server/enterprise/services/skillCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof SkillCatalog>();
  return {
    ...actual,
    getBuiltinSkillDefinitions: () => [],
    SkillCatalogReadService: vi.fn().mockImplementation(() => ({
      resolvePinnedForExecution: mocks.resolvePinnedForExecution,
    })),
  };
});
vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { initWithEnvKey: async () => ({}) },
}));

const ref = {
  checksum: 'a'.repeat(64),
  skillKey: 'historical.skill',
  version: '1.0.0',
};

const caller = () =>
  agentSkillsRouter.createCaller({ serverDB: {}, userId: 'user-1', workspaceId: null } as never);

describe('agentSkills.resolvePlatformPinned', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPolicySnapshot.mockResolvedValue({
      published: { skills: { enforcementMode: 'enforced', managed: true } },
      status: 'published',
    });
    mocks.resolvePinnedForExecution.mockResolvedValue({
      allowBuiltinOverride: false,
      checksum: ref.checksum,
      content: '# historical v1',
      contentRef: null,
      description: 'Historical',
      displayName: 'Historical Skill',
      distribution: 'optional',
      manifest: {},
      resources: [],
      skillId: 'skill-1',
      skillKey: ref.skillKey,
      source: 'uploaded',
      version: ref.version,
      versionId: 'version-1',
    });
  });

  it('resolves an exact historical published ref without consulting the moving catalog head', async () => {
    await expect(caller().resolvePlatformPinned(ref)).resolves.toMatchObject({
      checksum: ref.checksum,
      content: '# historical v1',
      identifier: ref.skillKey,
      version: ref.version,
    });
    expect(mocks.resolvePinnedForExecution).toHaveBeenCalledWith(ref);
    expect(PlatformManagedResourcePolicyModel).toHaveBeenCalledTimes(1);
    expect(SkillCatalogReadService).toHaveBeenCalledTimes(1);
  });

  it('rejects exact historical reads outside enforced mode', async () => {
    mocks.getPolicySnapshot.mockResolvedValue({
      published: { skills: { enforcementMode: 'ui-only', managed: true } },
      status: 'published',
    });

    await expect(caller().resolvePlatformPinned(ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.resolvePinnedForExecution).not.toHaveBeenCalled();
  });
});
