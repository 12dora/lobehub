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
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentModel } from '@/database/models/agent';
import { FileModel } from '@/database/models/file';
import { KnowledgeBaseModel } from '@/database/models/knowledgeBase';
import { SessionModel } from '@/database/models/session';
import { TaskModel } from '@/database/models/task';
import { agentRouter } from '@/server/routers/lambda/agent';
import { AgentService } from '@/server/services/agent';

const { getEffectiveAgentSpy } = vi.hoisted(() => ({
  getEffectiveAgentSpy: vi.fn(),
}));

vi.mock('@/server/enterprise/services/agentCatalog', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertLocalAgentReadableUnderTakeover: vi.fn(async () => undefined),
    PlatformAgentEffectiveResolver: class {
      getEffectiveAgent = getEffectiveAgentSpy;
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

describe('agent.getAgentConfigById encoded platform ids', () => {
  let mockCtx: { userId: string };
  let agentServiceMock: { getAgentConfigById: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    getEffectiveAgentSpy.mockReset();

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

  it('resolves platform-agent: ids via the effective catalog so CLI view matches list ids', async () => {
    getEffectiveAgentSpy.mockResolvedValue({
      agentKey: 'managed-bot',
      checksum: 'a'.repeat(64),
      config: {
        avatar: '🤖',
        backgroundColor: '#111',
        description: 'A published platform agent',
        displayName: 'Managed Bot',
        modelParameters: {},
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
    expect(agentServiceMock.getAgentConfigById).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      description: 'A published platform agent',
      id: ENCODED_ID,
      platform: { managed: true, source: 'platform' },
      systemRole: 'You are a managed assistant.',
      title: 'Managed Bot',
    });
  });

  it('returns null when the encoded platform agent is not in the caller effective set', async () => {
    getEffectiveAgentSpy.mockResolvedValue(null);

    const caller = agentRouter.createCaller(mockCtx as never);
    const result = await caller.getAgentConfigById({ agentId: ENCODED_ID });

    expect(result).toBeNull();
    expect(getEffectiveAgentSpy).toHaveBeenCalledWith(USER, PLATFORM_AGENT_ID);
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
