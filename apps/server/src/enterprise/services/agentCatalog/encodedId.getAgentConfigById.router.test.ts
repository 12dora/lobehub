/**
 * Official CLI `lh agent view <id-from-list>` under agent takeover.
 * Encoded list ids (`platform-agent:<uuid>`) must resolve through the effective
 * catalog — the same identity seam execAgent uses — instead of looking up the
 * synthetic id as a local Agent row.
 *
 * Lives next to the catalog so lambda `__tests__` stay off the enterprise import
 * allowlist (see userList.replace.router.test.ts).
 *
 * @vitest-environment node
 */
import { encodePlatformAgentListId } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentModel } from '@/database/models/agent';
import { FileModel } from '@/database/models/file';
import { KnowledgeBaseModel } from '@/database/models/knowledgeBase';
import { SessionModel } from '@/database/models/session';
import { TaskModel } from '@/database/models/task';
import type { PlatformAgentOperationSnapshot } from '@/server/enterprise/services/agentCatalog';
import { buildPlatformAgentRuntimeConfig } from '@/server/enterprise/services/agentCatalog';
import { agentRouter } from '@/server/routers/lambda/agent';
import { AgentService } from '@/server/services/agent';

const { getEffectiveAgentSpy, projectRuntimeConfigSpy } = vi.hoisted(() => ({
  getEffectiveAgentSpy: vi.fn(),
  projectRuntimeConfigSpy: vi.fn(),
}));

vi.mock('@/server/enterprise/services/agentCatalog', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertLocalAgentReadableUnderTakeover: vi.fn(async () => undefined),
    PlatformAgentEffectiveResolver: class {
      getEffectiveAgent = getEffectiveAgentSpy;
    },
    PlatformAgentMaterializationService: class {
      projectRuntimeConfig = projectRuntimeConfigSpy;
    },
  };
});

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => ({})) }));
vi.mock('@/database/models/agent', () => ({ AgentModel: vi.fn() }));
vi.mock('@/database/models/chatGroup', () => ({ ChatGroupModel: vi.fn() }));
vi.mock('@/database/models/session', () => ({ SessionModel: vi.fn() }));
vi.mock('@/database/models/task', () => ({ TaskModel: vi.fn() }));
vi.mock('@/database/models/file', () => ({ FileModel: vi.fn() }));
vi.mock('@/database/models/knowledgeBase', () => ({ KnowledgeBaseModel: vi.fn() }));
vi.mock('@/server/services/agent', () => ({ AgentService: vi.fn() }));
vi.mock('@/server/services/editLock', () => ({ EditLockService: vi.fn() }));
vi.mock('@/server/services/resourceEvents', () => ({ publishResourceEvent: vi.fn() }));

const USER = 'encoded-view-user';
const LOCAL_AGENT_ID = 'agt_encoded_view_local';
const PLATFORM_AGENT_ID = 'pagt_encoded_view';
const ENCODED_ID = encodePlatformAgentListId(PLATFORM_AGENT_ID);

const PINNED_DEPENDENCIES = {
  connectors: [],
  model: {
    modelKey: 'qwen-plus',
    providerChecksum: 'b'.repeat(64),
    providerKey: 'qwen',
    providerRevision: 1,
  },
  skills: [],
};

describe('agent.getAgentConfigById encoded platform ids', () => {
  let mockCtx: { userId: string };
  let agentServiceMock: { getAgentConfigById: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // Guard is a no-op when managed agents are off — these tests cover the encoded-id
    // projection, not the active-user gate (see managedAgentActiveUser.guard.test.ts).
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '0');
    getEffectiveAgentSpy.mockReset();
    projectRuntimeConfigSpy.mockReset();
    projectRuntimeConfigSpy.mockImplementation(
      async (agentId: string, snapshot: PlatformAgentOperationSnapshot) =>
        buildPlatformAgentRuntimeConfig(agentId, snapshot, PINNED_DEPENDENCIES),
    );

    agentServiceMock = {
      getAgentConfigById: vi.fn(),
    };
    vi.mocked(AgentService).mockImplementation(() => agentServiceMock as never);
    vi.mocked(AgentModel).mockImplementation(() => ({}) as never);
    vi.mocked(SessionModel).mockImplementation(() => ({}) as never);
    vi.mocked(TaskModel).mockImplementation(() => ({}) as never);
    vi.mocked(FileModel).mockImplementation(() => ({}) as never);
    vi.mocked(KnowledgeBaseModel).mockImplementation(() => ({}) as never);

    mockCtx = { userId: USER };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves platform-agent: ids via the pinned version (model/provider/params/tags)', async () => {
    getEffectiveAgentSpy.mockResolvedValue({
      agentKey: 'managed-bot',
      checksum: 'a'.repeat(64),
      config: {
        avatar: '🤖',
        backgroundColor: '#111',
        description: 'A published platform agent',
        displayName: 'Managed Bot',
        modelParameters: { maxTokens: 2048, temperature: 0.2 },
        openingMessage: 'Hello',
        openingQuestions: ['What can you do?'],
        systemRole: 'You are a managed assistant.',
        tags: ['platform'],
      },
      distribution: 'mandatory',
      mutable: false,
      platformAgentId: PLATFORM_AGENT_ID,
      source: 'platform',
      systemKey: null,
      version: '1.0.0',
      versionId: 'ver_1',
    });

    const caller = agentRouter.createCaller(mockCtx as never);
    const result = await caller.getAgentConfigById({ agentId: ENCODED_ID });

    expect(getEffectiveAgentSpy).toHaveBeenCalledWith(USER, PLATFORM_AGENT_ID);
    expect(projectRuntimeConfigSpy).toHaveBeenCalledWith(
      ENCODED_ID,
      expect.objectContaining({
        checksum: 'a'.repeat(64),
        platformAgentId: PLATFORM_AGENT_ID,
        versionId: 'ver_1',
      }),
    );
    expect(agentServiceMock.getAgentConfigById).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      description: 'A published platform agent',
      id: ENCODED_ID,
      model: 'qwen-plus',
      platform: { distribution: 'mandatory', managed: true, source: 'platform' },
      provider: 'qwen',
      systemRole: 'You are a managed assistant.',
      tags: ['platform'],
      title: 'Managed Bot',
    });
    expect(result?.params).toMatchObject({ max_tokens: 2048, temperature: 0.2 });
  });

  it('returns null when the encoded platform agent is not in the caller effective set', async () => {
    getEffectiveAgentSpy.mockResolvedValue(null);

    const caller = agentRouter.createCaller(mockCtx as never);
    const result = await caller.getAgentConfigById({ agentId: ENCODED_ID });

    expect(result).toBeNull();
    expect(getEffectiveAgentSpy).toHaveBeenCalledWith(USER, PLATFORM_AGENT_ID);
    expect(projectRuntimeConfigSpy).not.toHaveBeenCalled();
    expect(agentServiceMock.getAgentConfigById).not.toHaveBeenCalled();
  });

  it('falls through to the local agent service for ordinary ids', async () => {
    const local = { id: LOCAL_AGENT_ID, title: 'Local agent' };
    agentServiceMock.getAgentConfigById.mockResolvedValue(local);

    const caller = agentRouter.createCaller(mockCtx as never);
    const result = await caller.getAgentConfigById({ agentId: LOCAL_AGENT_ID });

    expect(getEffectiveAgentSpy).not.toHaveBeenCalled();
    expect(agentServiceMock.getAgentConfigById).toHaveBeenCalledWith(LOCAL_AGENT_ID);
    expect(result).toEqual(local);
  });
});
