import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adminAgentsService, createLambdaAdminAgentsClient } from './adminAgents';

const mocks = vi.hoisted(() => ({
  agents: {
    archive: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    listVersions: vi.fn(),
    rollback: vi.fn(),
    save: vi.fn(),
    setDefaultInbox: vi.fn(),
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
        archive: { mutate: mocks.agents.archive },
        assignments: {
          list: { query: mocks.assignments.list },
          preview: { query: mocks.assignments.preview },
          remove: { mutate: mocks.assignments.remove },
          upsert: { mutate: mocks.assignments.upsert },
        },
        create: { mutate: mocks.agents.create },
        delete: { mutate: mocks.agents.delete },
        get: { query: mocks.agents.get },
        list: { query: mocks.agents.list },
        listVersions: { query: mocks.agents.listVersions },
        rollback: { mutate: mocks.agents.rollback },
        save: { mutate: mocks.agents.save },
        rollouts: {
          cancel: { mutate: mocks.rollouts.cancel },
          get: { query: mocks.rollouts.get },
          list: { query: mocks.rollouts.list },
          retry: { mutate: mocks.rollouts.retry },
          rollback: { mutate: mocks.rollouts.rollback },
          start: { mutate: mocks.rollouts.start },
        },
        setDefaultInbox: { mutate: mocks.agents.setDefaultInbox },
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
    mocks.agents.listVersions.mockResolvedValue({ items: [], nextCursor: null });
    mocks.assignments.list.mockResolvedValue({ items: [], nextCursor: null });
    mocks.assignments.preview.mockResolvedValue({ estimatedUsers: 3, warnings: [] });

    const listInput = { cursor: 'c1', limit: 100, query: 'q', status: 'published' as const };
    await client.list(listInput);
    await client.get({ id: 'agent-1' });
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
    expect(mocks.assignments.list).toHaveBeenCalledOnce();
    expect(mocks.assignments.preview).toHaveBeenCalledOnce();
  });

  it('routes every write through the matching mutate procedure with the exact input', async () => {
    const client = createLambdaAdminAgentsClient();
    for (const fn of allProcedureMocks()) fn.mockResolvedValue({ ok: true });

    const createInput = {
      agentKey: 'support',
      config: {} as never,
      dependencySnapshot: {} as never,
      isDefault: false,
      reason: 'create',
      systemKey: null,
    };
    const saveInput = {
      agentId: 'agent-1',
      config: {} as never,
      dependencySnapshot: {} as never,
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 1,
      reason: 'save',
    };
    const rollbackInput = {
      agentId: 'agent-1',
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 1,
      reason: 'rollback',
      targetVersionId: 'v1',
    };
    const archiveInput = {
      agentId: 'agent-1',
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 1,
      reason: 'archive',
      replacementAgentId: null,
    };
    const removeAssignmentInput = {
      agentId: 'agent-1',
      assignmentId: 'assignment-1',
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 1,
      reason: 'remove',
    };
    const deleteInput = {
      agentId: 'agent-1',
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 3,
      reason: 'Platform assistant hard-deleted from admin console',
    };
    const setDefaultInboxInput = {
      currentDefault: {
        agentId: 'agent-old',
        expectedDraftToken: 'b'.repeat(64),
        expectedRevision: 2,
      },
      nextDefault: {
        agentId: 'agent-1',
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 3,
      },
      reason: 'switch default',
    };
    const upsertAssignmentInput = {
      agentId: 'agent-1',
      assignmentId: 'assignment-1',
      enabled: true,
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 3,
      mode: 'optional' as const,
      pinnedVersionId: null,
      reason: 'assign',
      targetId: '__global__',
      targetType: 'global' as const,
      versionPolicy: 'latest_published' as const,
    };

    await client.create(createInput);
    await client.save(saveInput);
    await client.rollback(rollbackInput);
    await client.archive(archiveInput);
    await client.removeAssignment(removeAssignmentInput);
    await client.delete(deleteInput);
    await client.setDefaultInbox(setDefaultInboxInput);
    await client.upsertAssignment(upsertAssignmentInput);

    expect(mocks.agents.create).toHaveBeenCalledWith(createInput);
    expect(mocks.agents.save).toHaveBeenCalledWith(saveInput);
    expect(mocks.agents.rollback).toHaveBeenCalledWith(rollbackInput);
    expect(mocks.agents.archive).toHaveBeenCalledWith(archiveInput);
    expect(mocks.assignments.remove).toHaveBeenCalledWith(removeAssignmentInput);
    expect(mocks.agents.delete).toHaveBeenCalledWith(deleteInput);
    expect(mocks.agents.setDefaultInbox).toHaveBeenCalledWith(setDefaultInboxInput);
    expect(mocks.assignments.upsert).toHaveBeenCalledWith(upsertAssignmentInput);
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
