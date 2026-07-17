// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { AgentOperationModel } from '@/database/models/agentOperation';
import { agentOperations, agents, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { platformRouter } from './platform';

const db: LobeChatDatabase = await getTestDB();
const createRootCaller = createCallerFactory(platformRouter);
const createCaller = (context: Parameters<typeof createRootCaller>[0]) =>
  createRootCaller(context).skills;
const userId = 'm08-platform-skill-user';
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
  await db.delete(users);
  await db.insert(users).values({ id: userId });
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
