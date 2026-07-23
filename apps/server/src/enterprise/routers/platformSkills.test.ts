// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_ERROR_CODES } from '@/const/platform/errorCodes';
import { getTestDB } from '@/database/core/getTestDB';
import { AgentOperationModel } from '@/database/models/agentOperation';
import { agentOperations, agents, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { getEnterpriseErrorBody } from '../guards/enterpriseErrors';
import { platformRouter } from './platform';

const db: LobeChatDatabase = await getTestDB();
const createRootCaller = createCallerFactory(platformRouter);
const createCaller = (context: Parameters<typeof createRootCaller>[0]) =>
  createRootCaller(context).skills;
const userId = 'm08-platform-skill-user';
const IDS = {
  banned: 'm08-platform-skill-banned',
  epoch: 'm08-platform-skill-epoch',
  tempBanned: 'm08-platform-skill-temp-banned',
} as const;
const operationMocks = vi.hoisted(() => ({
  resolvePolicies: vi.fn(),
  signProof: vi.fn(),
}));

vi.mock('@/libs/trpc/utils/internalJwt', () => ({
  signPlatformSkillOperationProof: operationMocks.signProof,
}));

vi.mock('../services/managedResourceCapabilities', () => ({
  resolvePublishedManagedResourcePolicies: operationMocks.resolvePolicies,
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

vi.mock('@lobechat/builtin-skills', () => ({
  builtinSkills: [
    {
      content: '# Mock builtin Skill',
      description: 'Mock builtin Skill',
      identifier: 'mock-builtin',
      name: 'Mock builtin',
      source: 'builtin',
    },
  ],
}));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await db.delete(agentOperations);
  await db.delete(agents);
  await db.delete(users);
  await db
    .insert(users)
    .values([
      { id: userId },
      { banned: true, id: IDS.banned },
      { banExpires: new Date(Date.now() + 3_600_000), banned: true, id: IDS.tempBanned },
      { authInvalidatedAt: new Date('2021-01-01T00:00:00.000Z'), id: IDS.epoch },
    ]);
  await db.insert(agents).values({ id: 'agent-1', plugins: [], userId });
  operationMocks.resolvePolicies.mockResolvedValue({ publicCapabilities: { skills: true } });
  operationMocks.signProof.mockResolvedValue('signed-proof');
});

afterEach(async () => {
  await db.delete(agentOperations);
  await db.delete(agents);
  await db.delete(users);
  vi.unstubAllEnvs();
});

describe('platformSkillsRouter', () => {
  it('denies anonymous access and exposes no server-only resolver procedure', async () => {
    const anonymous = createCaller({ ...(await createContextInner()), serverDB: db } as never);
    await expect(anonymous.getPublished()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(anonymous.getPublishedCatalog()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      anonymous.beginOperation({
        agentId: 'agent-1',
        operationId: 'operation-1',
        refs: [],
        revision: 'revision-1',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect('resolveForExecution' in anonymous).toBe(false);
  });

  it('returns a stable empty public catalog when the feature is off', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '0');
    const caller = createCaller({
      ...(await createContextInner({ userId })),
      serverDB: db,
    } as never);
    await expect(caller.getPublished()).resolves.toEqual({ revision: 'disabled', skills: [] });
    await expect(caller.getPublishedCatalog()).resolves.toEqual({
      revision: 'disabled',
      skills: [],
    });
  });

  it('returns strict builtin public metadata without execution content', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
    const caller = createCaller({
      ...(await createContextInner({ userId })),
      serverDB: db,
    } as never);
    const catalog = await caller.getPublished();
    expect(catalog.skills.length).toBeGreaterThan(0);
    expect(catalog.skills[0]).toEqual({
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      description: expect.any(String),
      displayName: expect.any(String),
      distribution: 'default',
      skillKey: expect.any(String),
      source: 'builtin',
      version: '0.0.0',
    });
    expect(JSON.stringify(catalog)).not.toContain('contentRef');
    expect(JSON.stringify(catalog)).not.toContain('manifest');
    expect(JSON.stringify(catalog)).not.toContain('resources');
  });

  it('signs only exact refs from the current published head', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
    const caller = createCaller({
      ...(await createContextInner({ userId })),
      serverDB: db,
    } as never);
    const catalog = await caller.getPublishedCatalog();
    const refs = catalog.skills.map(({ checksum, skillKey, version }) => ({
      checksum,
      skillKey,
      version,
    }));

    await expect(
      caller.beginOperation({
        agentId: 'agent-1',
        operationId: 'operation-1',
        refs,
        revision: catalog.revision,
      }),
    ).resolves.toEqual({
      agentId: 'agent-1',
      operationId: 'operation-1',
      proof: 'signed-proof',
      refs,
      revision: catalog.revision,
    });
    await expect(
      new AgentOperationModel(db, userId).findById('operation-1'),
    ).resolves.toMatchObject({ agentId: 'agent-1', status: 'running' });
  });

  it('rejects refs that omit the persisted mandatory selection', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
    const caller = createCaller({
      ...(await createContextInner({ userId })),
      serverDB: db,
    } as never);
    const catalog = await caller.getPublishedCatalog();

    await expect(
      caller.beginOperation({
        agentId: 'agent-1',
        operationId: 'operation-1',
        refs: [],
        revision: catalog.revision,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects an agent outside the authenticated ownership scope', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
    const caller = createCaller({
      ...(await createContextInner({ userId })),
      serverDB: db,
    } as never);
    const catalog = await caller.getPublishedCatalog();

    await expect(
      caller.beginOperation({
        agentId: 'other-agent',
        operationId: 'operation-1',
        refs: catalog.skills.map(({ checksum, skillKey, version }) => ({
          checksum,
          skillKey,
          version,
        })),
        revision: catalog.revision,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects a proof request when the persisted operation belongs to another agent', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
    await db.insert(agents).values({ id: 'agent-2', plugins: [], userId });
    await new AgentOperationModel(db, userId).recordStart({
      agentId: 'agent-2',
      operationId: 'operation-agent-2',
    });
    const caller = createCaller({
      ...(await createContextInner({ userId })),
      serverDB: db,
    } as never);
    const catalog = await caller.getPublishedCatalog();

    await expect(
      caller.beginOperation({
        agentId: 'agent-1',
        operationId: 'operation-agent-2',
        refs: catalog.skills.map(({ checksum, skillKey, version }) => ({
          checksum,
          skillKey,
          version,
        })),
        revision: catalog.revision,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(operationMocks.signProof).not.toHaveBeenCalled();
  });
});

describe('managed Skills reject banned, temporary-banned, and epoch-invalid principals', () => {
  const expectAccessDenied = (error: unknown) => {
    const body = getEnterpriseErrorBody(error);
    expect(
      body?.code === ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED ||
        (error as { code?: string }).code === 'UNAUTHORIZED',
    ).toBe(true);
  };

  const callerFor = async (
    id: string,
    extras?: { authMethod?: 'better-auth' | 'oidc'; credentialIssuedAt?: Date },
  ) =>
    createCaller({
      ...(await createContextInner({
        authMethod: extras?.authMethod ?? 'oidc',
        credentialIssuedAt: extras?.credentialIssuedAt ?? new Date('2020-01-01T00:00:00.000Z'),
        userId: id,
      })),
      serverDB: db,
    } as never);

  beforeEach(() => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
  });

  it('rejects a banned caller on getPublishedCatalog', async () => {
    const caller = await callerFor(IDS.banned);
    try {
      await caller.getPublishedCatalog();
      expect.fail('expected banned caller to be denied');
    } catch (error) {
      expectAccessDenied(error);
    }
  });

  it('rejects a temporarily-banned caller on beginOperation', async () => {
    const caller = await callerFor(IDS.tempBanned);
    try {
      await caller.beginOperation({
        agentId: 'agent-1',
        operationId: 'operation-1',
        refs: [],
        revision: 'revision-1',
      });
      expect.fail('expected temp-banned caller to be denied');
    } catch (error) {
      expectAccessDenied(error);
    }
    expect(operationMocks.signProof).not.toHaveBeenCalled();
  });

  it('rejects an epoch-invalidated caller on getPublishedCatalog', async () => {
    const caller = await callerFor(IDS.epoch, { authMethod: 'oidc' });
    try {
      await caller.getPublishedCatalog();
      expect.fail('expected epoch-invalid caller to be denied');
    } catch (error) {
      expectAccessDenied(error);
    }
  });
});
