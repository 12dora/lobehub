// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SkillCatalog from '@/server/enterprise/services/skillCatalog';
import { SkillCatalogReadService } from '@/server/enterprise/services/skillCatalog';

import { agentSkillsRouter } from '../agentSkills';

const mocks = vi.hoisted(() => ({
  getPublishedCatalog: vi.fn(),
  resolvePinnedForExecution: vi.fn(),
  resolvePolicies: vi.fn(),
  validateProof: vi.fn(),
}));

vi.mock('@/business/server/trpc-middlewares/workspaceAuth', async () => {
  const mod = await vi.importActual<{ trpc: any }>('@/libs/trpc/lambda/init');
  return { wsCompatProcedure: mod.trpc.procedure };
});
vi.mock('@/libs/trpc/lambda/middleware', () => ({
  serverDatabase: async (opts: any) =>
    opts.next({ ctx: { ...opts.ctx, serverDB: opts.ctx.serverDB ?? {} } }),
}));
vi.mock('@/libs/trpc/utils/internalJwt', () => ({
  validatePlatformSkillOperationProof: mocks.validateProof,
}));
vi.mock('@/server/enterprise/featureFlags', () => ({
  parseEnterpriseFeatureFlags: () => ({ ENABLE_PLATFORM_MANAGED_SKILLS: true }),
}));
vi.mock('@/server/enterprise/services/managedResourceCapabilities', () => ({
  resolvePublishedManagedResourcePolicies: mocks.resolvePolicies,
}));
vi.mock('@/server/enterprise/services/skillCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof SkillCatalog>();
  return {
    ...actual,
    getBuiltinSkillDefinitions: () => [],
    SkillCatalogReadService: vi.fn().mockImplementation(() => ({
      getPublishedCatalog: mocks.getPublishedCatalog,
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
    mocks.getPublishedCatalog.mockResolvedValue({ revision: 'current', skills: [ref] });
    mocks.resolvePolicies.mockResolvedValue({ publicCapabilities: { skills: true } });
    mocks.validateProof.mockResolvedValue(true);
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

  it('allows ui-only clients to read an exact current published ref', async () => {
    await expect(caller().resolvePlatformPinned({ ref })).resolves.toMatchObject({
      checksum: ref.checksum,
      content: '# historical v1',
      identifier: ref.skillKey,
      version: ref.version,
    });
    expect(mocks.resolvePinnedForExecution).toHaveBeenCalledWith(ref);
    expect(mocks.getPublishedCatalog).toHaveBeenCalledTimes(1);
    expect(SkillCatalogReadService).toHaveBeenCalledTimes(1);
  });

  it('rejects a raw historical ref that does not match the current head', async () => {
    mocks.getPublishedCatalog.mockResolvedValue({ revision: 'current', skills: [] });

    await expect(caller().resolvePlatformPinned({ ref })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mocks.resolvePinnedForExecution).not.toHaveBeenCalled();
  });

  it('resolves a historical ref only through a valid user-bound operation proof', async () => {
    const operation = {
      agentId: 'agent-1',
      operationId: 'operation-1',
      proof: 'signed-proof',
      refs: [ref],
      revision: 'historical-revision',
    };

    await expect(caller().resolvePlatformPinned({ operation, ref })).resolves.toMatchObject({
      identifier: ref.skillKey,
      version: ref.version,
    });
    expect(mocks.validateProof).toHaveBeenCalledWith('signed-proof', {
      agentId: operation.agentId,
      operationId: operation.operationId,
      refs: operation.refs,
      revision: operation.revision,
      userId: 'user-1',
    });
    expect(mocks.getPublishedCatalog).not.toHaveBeenCalled();
    expect(mocks.resolvePolicies).not.toHaveBeenCalled();
  });
});
