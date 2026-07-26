/**
 * Direct unit coverage for PlatformAgentExecutionResolver (SAS-03).
 * Integration coverage remains in execAgentPlatform.test.ts.
 *
 * @vitest-environment node
 */
import { INBOX_SESSION_ID } from '@lobechat/const';
import { encodePlatformAgentListId } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PlatformAgentDependencyValidationError,
  PlatformAgentMaterializationError,
  PlatformAgentNotFoundError,
} from './errors';
import {
  PLATFORM_AUDITED_BUILTIN_TOOL_IDS,
  PlatformAgentExecutionResolver,
} from './platformAgentExecutionResolver';

const {
  beginOperation,
  isEntitled,
  materializeForOperation,
  materializeFromPin,
  resolveForExistingAgent,
  resolveFromPinForExistingAgent,
  getBuiltinAgent,
  getAgentConfigById,
  findResumablePlatformOperationPin,
  getPlatformAgentIdByMaterializedAgentId,
  captureInbox,
  validateDependencies,
  messageFindById,
  messageFindPlugin,
} = vi.hoisted(() => ({
  beginOperation: vi.fn(),
  captureInbox: vi.fn(),
  findResumablePlatformOperationPin: vi.fn(),
  getAgentConfigById: vi.fn(),
  getBuiltinAgent: vi.fn(),
  getPlatformAgentIdByMaterializedAgentId: vi.fn(),
  isEntitled: vi.fn(async () => true),
  materializeForOperation: vi.fn(),
  materializeFromPin: vi.fn(),
  messageFindById: vi.fn(),
  messageFindPlugin: vi.fn(),
  resolveForExistingAgent: vi.fn(),
  resolveFromPinForExistingAgent: vi.fn(),
  validateDependencies: vi.fn(async () => ({ valid: true as const })),
}));

vi.mock('./defaultInbox', () => ({
  PlatformDefaultInboxService: class {
    capture = captureInbox;
  },
}));

vi.mock('@/database/repositories/platformAgentCatalog', () => ({
  PlatformAgentCatalogRepository: class {
    getPlatformAgentIdByMaterializedAgentId = getPlatformAgentIdByMaterializedAgentId;
  },
}));

vi.mock('@lobechat/types', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fingerprintResumeToolCall: vi.fn(async () => 'fp-1'),
  };
});

const pin = {
  checksum: 'a'.repeat(64),
  platformAgentId: 'pagt_1',
  versionId: 'pav_1',
};

const dependencySnapshot = {
  connectors: [{ connectorKey: 'conn.a' }],
  model: {
    modelKey: 'm',
    providerChecksum: 'b'.repeat(64),
    providerKey: 'p',
    providerRevision: 1,
  },
  skills: [],
};

const buildResolver = () =>
  new PlatformAgentExecutionResolver({
    agentModel: { getAgentConfigById, getBuiltinAgent },
    agentOperationModel: { findResumablePlatformOperationPin },
    createEffectiveResolver: () => ({ beginOperation, isEntitled }),
    createMaterializationService: () => ({
      materializeForOperation,
      materializeFromPin,
      resolveForExistingAgent,
      resolveFromPinForExistingAgent,
    }),
    db: {} as never,
    messageModel: { findById: messageFindById, findMessagePlugin: messageFindPlugin },
    userId: 'user-a',
    validateDependencies,
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
  isEntitled.mockResolvedValue(true);
  validateDependencies.mockResolvedValue({ valid: true as const });
  messageFindById.mockResolvedValue({ id: 'msg-1' });
  messageFindPlugin.mockResolvedValue({
    apiName: 'deleteRecords',
    arguments: '{}',
    identifier: 'lobe-database',
    intervention: { kind: 'approval', status: 'pending' },
    toolCallId: 'tc-1',
    type: 'default',
  });
});

describe('PlatformAgentExecutionResolver.resolveIdentity', () => {
  it('returns the platform agent id for an encoded list identity', async () => {
    const encoded = encodePlatformAgentListId('pagt_1');
    const result = await buildResolver().resolveIdentity(encoded, undefined);
    expect(result).toEqual({ platformAgentId: 'pagt_1' });
    expect(getBuiltinAgent).not.toHaveBeenCalled();
    expect(beginOperation).not.toHaveBeenCalled();
  });

  it('returns null when managed agents are disabled', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '0');
    const result = await buildResolver().resolveIdentity('agt_local', 'agt_local');
    expect(result).toBeNull();
    expect(getPlatformAgentIdByMaterializedAgentId).not.toHaveBeenCalled();
  });

  it('inbox + paused resume returns captured pin and existing agent id', async () => {
    getBuiltinAgent.mockResolvedValue({ id: 'inbox-agt' });
    findResumablePlatformOperationPin.mockResolvedValue(pin);
    const result = await buildResolver().resolveIdentity(INBOX_SESSION_ID, undefined, {
      anchorMessageId: 'msg-1',
      kind: 'approval',
      threadId: null,
      toolCallId: 'tc-1',
      topicId: 'topic-1',
    });
    expect(result).toEqual({
      capturedResumePin: pin,
      existingAgentId: 'inbox-agt',
      platformAgentId: 'pagt_1',
    });
    expect(captureInbox).not.toHaveBeenCalled();
  });

  it('inbox fresh capture returns handle when default inbox is bound', async () => {
    getBuiltinAgent.mockResolvedValue({ id: 'inbox-agt' });
    captureInbox.mockResolvedValue({ platformAgentId: 'pagt_inbox' });
    const result = await buildResolver().resolveIdentity(INBOX_SESSION_ID, undefined);
    expect(result).toEqual({
      existingAgentId: 'inbox-agt',
      handle: { platformAgentId: 'pagt_inbox' },
      platformAgentId: 'pagt_inbox',
    });
  });

  it('inbox without capture falls through to null', async () => {
    getBuiltinAgent.mockResolvedValue({ id: 'inbox-agt' });
    captureInbox.mockResolvedValue(null);
    const result = await buildResolver().resolveIdentity(INBOX_SESSION_ID, undefined);
    expect(result).toBeNull();
  });

  it('reverse materialization returns the platform agent id for the owner', async () => {
    getPlatformAgentIdByMaterializedAgentId.mockResolvedValue('pagt_mat');
    const result = await buildResolver().resolveIdentity('agt_local', 'agt_local');
    expect(result).toEqual({ platformAgentId: 'pagt_mat' });
    expect(getPlatformAgentIdByMaterializedAgentId).toHaveBeenCalledWith('user-a', 'agt_local');
  });

  it('returns null when reverse materialization finds nothing', async () => {
    getPlatformAgentIdByMaterializedAgentId.mockResolvedValue(null);
    const result = await buildResolver().resolveIdentity('agt_ordinary', 'agt_ordinary');
    expect(result).toBeNull();
  });
});

describe('PlatformAgentExecutionResolver.resolveExecutionPlan', () => {
  const resumeContext = {
    pausedResumeKind: 'approval' as const,
    resumeAnchorMessageId: 'msg-1',
    resumeToolCallId: 'tc-1',
    threadId: null,
    topicId: 'topic-1',
  };

  it('resume-pin mismatch → NOT_FOUND', async () => {
    findResumablePlatformOperationPin.mockResolvedValue({
      ...pin,
      platformAgentId: 'pagt_OTHER',
    });
    await expect(
      buildResolver().resolveExecutionPlan('pagt_1', 'platform-agent:pagt_1', resumeContext),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(materializeFromPin).not.toHaveBeenCalled();
  });

  it('revoked entitlement on resume → NOT_FOUND', async () => {
    findResumablePlatformOperationPin.mockResolvedValue(pin);
    isEntitled.mockResolvedValue(false);
    await expect(
      buildResolver().resolveExecutionPlan('pagt_1', 'platform-agent:pagt_1', resumeContext),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(materializeFromPin).not.toHaveBeenCalled();
  });

  it('handle / platformAgentId mismatch → NOT_FOUND', async () => {
    beginOperation.mockResolvedValue({
      getSnapshot: () => ({ ...pin, platformAgentId: 'pagt_OTHER' }),
      platformAgentId: 'pagt_OTHER',
    });
    await expect(
      buildResolver().resolveExecutionPlan('pagt_1', 'platform-agent:pagt_1', {
        resumeAnchorMessageId: null,
        threadId: null,
        topicId: null,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(materializeForOperation).not.toHaveBeenCalled();
  });

  it('null beginOperation handle → NOT_FOUND', async () => {
    beginOperation.mockResolvedValue(null);
    await expect(
      buildResolver().resolveExecutionPlan('pagt_1', 'platform-agent:pagt_1', {
        resumeAnchorMessageId: null,
        threadId: null,
        topicId: null,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps PlatformAgentNotFoundError → NOT_FOUND', async () => {
    beginOperation.mockResolvedValue({
      getSnapshot: () => pin,
      platformAgentId: 'pagt_1',
    });
    materializeForOperation.mockRejectedValue(new PlatformAgentNotFoundError());
    await expect(
      buildResolver().resolveExecutionPlan('pagt_1', 'id', {
        resumeAnchorMessageId: null,
        threadId: null,
        topicId: null,
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'PLATFORM_AGENT_UNAVAILABLE',
    });
  });

  it('maps PlatformAgentDependencyValidationError → PRECONDITION_FAILED', async () => {
    beginOperation.mockResolvedValue({
      getSnapshot: () => pin,
      platformAgentId: 'pagt_1',
    });
    materializeForOperation.mockResolvedValue({
      config: { id: 'agt_x' },
      dependencySnapshot,
    });
    validateDependencies.mockRejectedValue(
      new PlatformAgentDependencyValidationError(['SKILL_UNAVAILABLE']),
    );
    await expect(
      buildResolver().resolveExecutionPlan('pagt_1', 'id', {
        resumeAnchorMessageId: null,
        threadId: null,
        topicId: null,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'PLATFORM_AGENT_DEPENDENCY_UNAVAILABLE',
    });
  });

  it('maps PlatformAgentMaterializationError → INTERNAL_SERVER_ERROR', async () => {
    beginOperation.mockResolvedValue({
      getSnapshot: () => pin,
      platformAgentId: 'pagt_1',
    });
    materializeForOperation.mockRejectedValue(new PlatformAgentMaterializationError());
    await expect(
      buildResolver().resolveExecutionPlan('pagt_1', 'id', {
        resumeAnchorMessageId: null,
        threadId: null,
        topicId: null,
      }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'PLATFORM_AGENT_START_FAILED',
    });
  });

  it('re-throws TRPCError from nested layers', async () => {
    beginOperation.mockResolvedValue({
      getSnapshot: () => pin,
      platformAgentId: 'pagt_1',
    });
    materializeForOperation.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'nope' }),
    );
    await expect(
      buildResolver().resolveExecutionPlan('pagt_1', 'id', {
        resumeAnchorMessageId: null,
        threadId: null,
        topicId: null,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'nope' });
  });

  it('maps unexpected errors → INTERNAL_SERVER_ERROR', async () => {
    beginOperation.mockResolvedValue({
      getSnapshot: () => pin,
      platformAgentId: 'pagt_1',
    });
    materializeForOperation.mockRejectedValue(new Error('sql detail'));
    await expect(
      buildResolver().resolveExecutionPlan('pagt_1', 'id', {
        resumeAnchorMessageId: null,
        threadId: null,
        topicId: null,
      }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'PLATFORM_AGENT_START_FAILED',
    });
  });

  it('returns an immutable plan with managed policy flags and connector-derived plugin ids', async () => {
    beginOperation.mockResolvedValue({
      getSnapshot: () => ({
        checksum: pin.checksum,
        platformAgentId: 'pagt_1',
        versionId: pin.versionId,
      }),
      platformAgentId: 'pagt_1',
    });
    materializeForOperation.mockResolvedValue({
      config: { id: 'agt_x', systemRole: 'role' },
      dependencySnapshot,
    });
    const plan = await buildResolver().resolveExecutionPlan('pagt_1', 'platform-agent:pagt_1', {
      resumeAnchorMessageId: null,
      threadId: null,
      topicId: null,
    });
    expect(plan.pin).toEqual(pin);
    expect(plan.connectorRefs).toEqual(dependencySnapshot.connectors);
    expect(plan.policy.allowLocalSystem).toBe(false);
    expect(plan.policy.allowRemoteDevice).toBe(false);
    expect(plan.policy.allowModelOverride).toBe(false);
    expect(plan.policy.exactBuiltinToolIds).toEqual([...PLATFORM_AUDITED_BUILTIN_TOOL_IDS]);
    expect(plan.policy.managedPluginIds).toEqual([...PLATFORM_AUDITED_BUILTIN_TOOL_IDS, 'conn.a']);
    expect(validateDependencies).toHaveBeenCalledWith({}, dependencySnapshot);
  });
});
