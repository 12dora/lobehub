import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adminAgentsService, createLambdaAdminAgentsClient } from './adminAgents';

const mocks = vi.hoisted(() => ({
  agents: {
    appendVersion: vi.fn(),
    archive: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    getDependents: vi.fn(),
    list: vi.fn(),
    listVersions: vi.fn(),
    publish: vi.fn(),
    rollback: vi.fn(),
    setDefaultInbox: vi.fn(),
    updateDraft: vi.fn(),
    validateDependencies: vi.fn(),
  },
  assignments: {
    list: vi.fn(),
    preview: vi.fn(),
    remove: vi.fn(),
    upsert: vi.fn(),
  },
  rollouts: {
    cancel: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    retry: vi.fn(),
    rollback: vi.fn(),
    start: vi.fn(),
  },
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      agents: {
        appendVersion: { mutate: mocks.agents.appendVersion },
        archive: { mutate: mocks.agents.archive },
        assignments: {
          list: { query: mocks.assignments.list },
          preview: { query: mocks.assignments.preview },
          remove: { mutate: mocks.assignments.remove },
          upsert: { mutate: mocks.assignments.upsert },
        },
        create: { mutate: mocks.agents.create },
        get: { query: mocks.agents.get },
        getDependents: { query: mocks.agents.getDependents },
        list: { query: mocks.agents.list },
        listVersions: { query: mocks.agents.listVersions },
        publish: { mutate: mocks.agents.publish },
        rollback: { mutate: mocks.agents.rollback },
        rollouts: {
          cancel: { mutate: mocks.rollouts.cancel },
          get: { query: mocks.rollouts.get },
          list: { query: mocks.rollouts.list },
          retry: { mutate: mocks.rollouts.retry },
          rollback: { mutate: mocks.rollouts.rollback },
          start: { mutate: mocks.rollouts.start },
        },
        setDefaultInbox: { mutate: mocks.agents.setDefaultInbox },
        updateDraft: { mutate: mocks.agents.updateDraft },
        validateDependencies: { mutate: mocks.agents.validateDependencies },
      },
    },
  },
}));

const allProcedureMocks = () => [
  ...Object.values(mocks.agents),
  ...Object.values(mocks.assignments),
  ...Object.values(mocks.rollouts),
];

describe('production admin agents adapter (lambdaClient)', () => {
  beforeEach(() => {
    for (const fn of allProcedureMocks()) fn.mockReset();
  });

  it('is the runtime default singleton and carries no mock catalog data', () => {
    // The exported production singleton must be the lambda-backed adapter, never the mock.
    expect(adminAgentsService.capabilities.rollouts).toBe(false);
    mocks.agents.list.mockResolvedValue({ items: [], nextCursor: null });
    // Delegates straight to the router — no seeded agents are returned locally.
    return expect(adminAgentsService.list({})).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('routes every read through the matching query procedure with the exact input', async () => {
    const client = createLambdaAdminAgentsClient();
    mocks.agents.list.mockResolvedValue({ items: [], nextCursor: null });
    mocks.agents.get.mockResolvedValue({ identity: { id: 'agent-1' } });
    mocks.agents.getDependents.mockResolvedValue({ items: [], nextCursor: null });
    mocks.agents.listVersions.mockResolvedValue({ items: [], nextCursor: null });
    mocks.assignments.list.mockResolvedValue({ items: [], nextCursor: null });
    mocks.assignments.preview.mockResolvedValue({ estimatedUsers: 3, warnings: [] });

    const listInput = { cursor: 'c1', limit: 100, query: 'q', status: 'published' as const };
    await client.list(listInput);
    await client.get({ id: 'agent-1' });
    await client.getDependents({ agentId: 'agent-1', cursor: 'x', limit: 100 });
    await client.listVersions({ agentId: 'agent-1', cursor: undefined, limit: 100 });
    await client.listAssignments({ agentId: 'agent-1', cursor: undefined, limit: 100 });
    await client.previewAssignment({
      agentId: 'agent-1',
      assignment: {
        enabled: true,
        mode: 'optional',
        pinnedVersionId: null,
        targetId: '__global__',
        targetType: 'global',
        versionPolicy: 'latest_published',
      },
    });

    expect(mocks.agents.list).toHaveBeenCalledWith(listInput);
    expect(mocks.agents.get).toHaveBeenCalledWith({ id: 'agent-1' });
    expect(mocks.agents.getDependents).toHaveBeenCalledWith({
      agentId: 'agent-1',
      cursor: 'x',
      limit: 100,
    });
    expect(mocks.assignments.list).toHaveBeenCalledOnce();
    expect(mocks.assignments.preview).toHaveBeenCalledOnce();
  });

  it('routes every write through the matching mutate procedure with the exact input', async () => {
    const client = createLambdaAdminAgentsClient();
    for (const fn of allProcedureMocks()) fn.mockResolvedValue({ ok: true });

    const createInput = {
      agentKey: 'support',
      isDefault: false,
      reason: 'create',
      systemKey: null,
    };
    await client.create(createInput);
    await client.appendVersion({
      agentId: 'agent-1',
      config: {} as never,
      dependencySnapshot: {} as never,
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 1,
      reason: 'save',
      version: '1.0.0',
    });
    await client.updateDraft({
      agentId: 'agent-1',
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 1,
      isDefault: false,
      reason: 'draft',
      systemKey: null,
    });
    await client.validateDependencies({ dependencySnapshot: {} as never });
    await client.publish({
      agentId: 'agent-1',
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 1,
      reason: 'publish',
      versionId: 'v1',
    });
    await client.rollback({
      agentId: 'agent-1',
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 1,
      reason: 'rollback',
      targetVersionId: 'v1',
    });
    await client.archive({
      agentId: 'agent-1',
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 1,
      reason: 'archive',
      replacementAgentId: null,
    });
    await client.removeAssignment({
      agentId: 'agent-1',
      assignmentId: 'assignment-1',
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 1,
      reason: 'remove',
    });

    expect(mocks.agents.create).toHaveBeenCalledWith(createInput);
    expect(mocks.agents.appendVersion).toHaveBeenCalledOnce();
    expect(mocks.agents.updateDraft).toHaveBeenCalledOnce();
    expect(mocks.agents.validateDependencies).toHaveBeenCalledOnce();
    expect(mocks.agents.publish).toHaveBeenCalledOnce();
    expect(mocks.agents.rollback).toHaveBeenCalledOnce();
    expect(mocks.agents.archive).toHaveBeenCalledOnce();
    expect(mocks.assignments.remove).toHaveBeenCalledOnce();
  });

  it('propagates router/network errors unchanged instead of masking them as empty', async () => {
    const client = createLambdaAdminAgentsClient();
    const failure = new Error('TRPCClientError: NETWORK');
    mocks.agents.list.mockRejectedValue(failure);
    await expect(client.list({})).rejects.toBe(failure);
  });

  it('routes every rollout action through the real PR-052 procedures', async () => {
    const client = createLambdaAdminAgentsClient();
    expect(client.capabilities.rollouts).toBe(false);
    for (const fn of Object.values(mocks.rollouts)) fn.mockResolvedValue({ ok: true });

    await client.startRollout({} as never);
    await client.cancelRollout({} as never);
    await client.retryRollout({} as never);
    await client.rollbackRollout({} as never);
    await client.getRollout({} as never);
    await client.listRollouts({} as never);

    for (const fn of Object.values(mocks.rollouts)) expect(fn).toHaveBeenCalledOnce();
  });
});
