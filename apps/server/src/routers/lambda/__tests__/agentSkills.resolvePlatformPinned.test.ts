// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import type * as SkillCatalog from '@/server/enterprise/services/skillCatalog';
import { SkillCatalogReadService } from '@/server/enterprise/services/skillCatalog';

import { agentSkillsRouter } from '../agentSkills';

const db: LobeChatDatabase = await getTestDB();

const IDS = {
  active: 'sr005-resolve-active',
  banned: 'sr005-resolve-banned',
  epoch: 'sr005-resolve-epoch',
  tempBanned: 'sr005-resolve-temp-banned',
} as const;

const mocks = vi.hoisted(() => ({
  getPublishedCatalog: vi.fn(),
  findOperation: vi.fn(),
  resolvePinnedForExecution: vi.fn(),
  resolvePolicies: vi.fn(),
  verifyProof: vi.fn(),
}));

vi.mock('@/business/server/trpc-middlewares/workspaceAuth', async () => {
  const mod = await vi.importActual<{ trpc: any }>('@/libs/trpc/lambda/init');
  return { wsCompatProcedure: mod.trpc.procedure };
});
vi.mock('@/libs/trpc/lambda/middleware', () => ({
  serverDatabase: async (opts: any) =>
    opts.next({ ctx: { ...opts.ctx, serverDB: opts.ctx.serverDB ?? db } }),
}));
// Real assertUserActive — SR-005 matrix seeds banned / temp-ban / epoch rows in the test DB.
vi.mock('@/libs/trpc/utils/internalJwt', () => ({
  hashPlatformSkillOperationRefs: vi.fn(() => 'refs-hash'),
  verifyPlatformSkillOperationProof: mocks.verifyProof,
}));
vi.mock('@/database/models/agentOperation', () => ({
  AgentOperationModel: vi.fn(() => ({ findById: mocks.findOperation })),
}));
vi.mock('@/server/enterprise/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Handler still sees managed Skills on; middleware uses getEnterpriseFeatureFlags(process.env).
    parseEnterpriseFeatureFlags: () => ({ ENABLE_PLATFORM_MANAGED_SKILLS: true }),
  };
});
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

const caller = (
  userId: string = IDS.active,
  extras?: { credentialIssuedAt?: Date; authMethod?: string },
) =>
  agentSkillsRouter.createCaller({
    authMethod: extras?.authMethod ?? 'oidc',
    credentialIssuedAt: extras?.credentialIssuedAt ?? new Date('2020-01-01T00:00:00.000Z'),
    serverDB: db,
    userId,
    workspaceId: null,
  } as never);

describe('agentSkills.resolvePlatformPinned', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await db.delete(users);
    await db
      .insert(users)
      .values([
        { id: IDS.active },
        { banned: true, id: IDS.banned },
        { banExpires: new Date(Date.now() + 3_600_000), banned: true, id: IDS.tempBanned },
        { authInvalidatedAt: new Date('2021-01-01T00:00:00.000Z'), id: IDS.epoch },
      ]);
    mocks.getPublishedCatalog.mockResolvedValue({ revision: 'current', skills: [ref] });
    mocks.findOperation.mockResolvedValue({
      agentId: 'agent-1',
      id: 'operation-1',
      status: 'running',
    });
    mocks.resolvePolicies.mockResolvedValue({ publicCapabilities: { skills: true } });
    mocks.verifyProof.mockResolvedValue({
      agentId: 'agent-1',
      operationId: 'operation-1',
      refsHash: 'refs-hash',
      revision: 'historical-revision',
      userId: IDS.active,
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

  afterEach(async () => {
    await db.delete(users);
    vi.unstubAllEnvs();
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
    expect(mocks.verifyProof).toHaveBeenCalledWith('signed-proof', IDS.active);
    expect(mocks.getPublishedCatalog).not.toHaveBeenCalled();
    expect(mocks.resolvePolicies).not.toHaveBeenCalled();
  });

  it('rejects a cross-agent envelope even when it carries a valid proof', async () => {
    await expect(
      caller().resolvePlatformPinned({
        operation: {
          agentId: 'agent-2',
          operationId: 'operation-1',
          proof: 'signed-proof',
          refs: [ref],
          revision: 'historical-revision',
        },
        ref,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.resolvePinnedForExecution).not.toHaveBeenCalled();
  });

  it('rejects proof A when the persisted operation belongs to agent B', async () => {
    mocks.findOperation.mockResolvedValue({
      agentId: 'agent-2',
      id: 'operation-1',
      status: 'running',
    });

    await expect(
      caller().resolvePlatformPinned({
        operation: {
          agentId: 'agent-1',
          operationId: 'operation-1',
          proof: 'signed-proof',
          refs: [ref],
          revision: 'historical-revision',
        },
        ref,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.resolvePinnedForExecution).not.toHaveBeenCalled();
  });

  describe('active-user revocation (SR-001 / SR-005) — DB-backed principal matrix', () => {
    const expectUnauthorizedWithoutSideEffects = async (userId: string) => {
      await expect(caller(userId).resolvePlatformPinned({ ref })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      expect(mocks.verifyProof).not.toHaveBeenCalled();
      expect(mocks.resolvePinnedForExecution).not.toHaveBeenCalled();
      expect(mocks.getPublishedCatalog).not.toHaveBeenCalled();
      expect(SkillCatalogReadService).not.toHaveBeenCalled();
    };

    it('rejects a banned principal before proof/catalog work', async () => {
      vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
      await expectUnauthorizedWithoutSideEffects(IDS.banned);
    });

    it('rejects a temporarily banned principal (banned + banExpires) before proof/catalog work', async () => {
      vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
      await expectUnauthorizedWithoutSideEffects(IDS.tempBanned);
    });

    it('rejects an epoch-invalid principal (credentialIssuedAt < authInvalidatedAt) before proof/catalog work', async () => {
      vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
      // Seeded authInvalidatedAt = 2021-01-01; credentialIssuedAt defaults to 2020-01-01.
      await expectUnauthorizedWithoutSideEffects(IDS.epoch);
    });

    it('allows an active principal when managed Skills are enabled', async () => {
      vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');

      await expect(caller().resolvePlatformPinned({ ref })).resolves.toMatchObject({
        identifier: ref.skillKey,
      });
      expect(mocks.resolvePinnedForExecution).toHaveBeenCalledWith(ref);
    });

    it('skips active-user enforcement when the managed Skills flag is off', async () => {
      vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '0');
      // Banned principal would fail if middleware ran; flag-off is a no-op.
      await expect(caller(IDS.banned).resolvePlatformPinned({ ref })).resolves.toMatchObject({
        identifier: ref.skillKey,
      });
    });
  });
});
