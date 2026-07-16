// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { marketRouter } from './market';

const mockPreprocessLhCommand = vi.hoisted(() => vi.fn());
const mockSandboxCallTool = vi.hoisted(() => vi.fn());
const mockCreateSandboxService = vi.hoisted(() =>
  vi.fn(() => ({
    callTool: mockSandboxCallTool,
  })),
);
const mockMarketSDK = vi.hoisted(() => ({
  skills: {
    callTool: vi.fn(),
    listLiveTools: vi.fn(),
    listTools: vi.fn(),
  },
}));
const managedSkillMocks = vi.hoisted(() => ({
  AgentSkillModel: vi.fn(() => ({ findByName: vi.fn() })),
  FileModel: vi.fn(() => ({ checkHash: vi.fn() })),
  PlatformManagedResourcePolicyModel: vi.fn(() => ({
    getSnapshot: vi.fn(),
  })),
  SkillCatalogReadService: vi.fn(() => ({
    resolvePinnedForExecution: vi.fn(),
  })),
  parseEnterpriseFeatureFlags: vi.fn(() => ({ ENABLE_PLATFORM_MANAGED_SKILLS: false })),
}));

vi.mock('@/database/models/agentSkill', () => ({
  AgentSkillModel: managedSkillMocks.AgentSkillModel,
}));

vi.mock('@/database/models/file', () => ({
  FileModel: managedSkillMocks.FileModel,
}));

vi.mock('@/database/models/platform', () => ({
  PlatformManagedResourcePolicyModel: managedSkillMocks.PlatformManagedResourcePolicyModel,
}));

vi.mock('@/server/enterprise/featureFlags', () => ({
  parseEnterpriseFeatureFlags: managedSkillMocks.parseEnterpriseFeatureFlags,
}));

vi.mock('@/server/enterprise/services/skillCatalog', () => ({
  getBuiltinSkillDefinitions: vi.fn(() => []),
  SkillCatalogReadService: managedSkillMocks.SkillCatalogReadService,
}));

vi.mock('@/libs/trpc/lambda/middleware', () => ({
  marketUserInfo: vi.fn((opts: any) => opts.next({ ctx: opts.ctx })),
  serverDatabase: vi.fn((opts: any) => opts.next({ ctx: opts.ctx })),
  telemetry: vi.fn((opts: any) => opts.next({ ctx: opts.ctx })),
}));

vi.mock('@/libs/trpc/lambda/middleware/marketSDK', () => ({
  marketSDK: vi.fn((opts: any) =>
    opts.next({
      ctx: {
        ...opts.ctx,
        marketSDK: mockMarketSDK,
      },
    }),
  ),
  requireMarketAuth: vi.fn((opts: any) => opts.next({ ctx: opts.ctx })),
}));

vi.mock('@/server/services/file', () => ({
  FileService: vi.fn(() => ({})),
}));

vi.mock('@/server/services/sandbox', () => ({
  createSandboxService: mockCreateSandboxService,
}));

vi.mock('@/server/services/toolExecution/preprocessLhCommand', () => ({
  preprocessLhCommand: mockPreprocessLhCommand,
}));

vi.mock('debug', () => ({
  default: vi.fn(() => vi.fn()),
}));

describe('tools marketRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managedSkillMocks.parseEnterpriseFeatureFlags.mockReturnValue({
      ENABLE_PLATFORM_MANAGED_SKILLS: false,
    });
  });

  it('should pass workspace scope when preprocessing sandbox lh commands', async () => {
    const caller = marketRouter.createCaller({
      serverDB: {},
      userId: 'user-1',
      workspaceId: 'workspace-1',
    } as any);
    mockPreprocessLhCommand.mockResolvedValue({
      command: 'LOBEHUB_WORKSPACE_ID=workspace-1 npx -y @lobehub/cli agent view agt_1',
      isLhCommand: true,
      skipSkillLookup: true,
    });
    mockSandboxCallTool.mockResolvedValue({ result: { ok: true }, success: true });

    await caller.execInSandbox({
      params: { command: 'lh agent view agt_1' },
      toolName: 'runCommand',
      topicId: 'topic-1',
    });

    expect(mockPreprocessLhCommand).toHaveBeenCalledWith(
      'lh agent view agt_1',
      'user-1',
      'workspace-1',
    );
    expect(mockSandboxCallTool).toHaveBeenCalledWith('runCommand', {
      command: 'LOBEHUB_WORKSPACE_ID=workspace-1 npx -y @lobehub/cli agent view agt_1',
    });
  });

  it('validates exact managed refs without consulting personal Skill ZIP storage', async () => {
    const checksum = 'a'.repeat(64);
    const getSnapshot = vi.fn().mockResolvedValue({
      published: { skills: { enforcementMode: 'enforced', managed: true } },
      status: 'published',
    });
    const resolvePinnedForExecution = vi.fn().mockResolvedValue({
      checksum,
      content: '# exact managed content',
      contentRef: null,
      resources: [
        {
          checksum: 'b'.repeat(64),
          content: 'print("ok")',
          mediaType: 'text/x-python',
          path: 'scripts/run.py',
          sizeBytes: 11,
        },
      ],
      skillKey: 'managed.skill',
      version: '1.0.0',
    });
    managedSkillMocks.parseEnterpriseFeatureFlags.mockReturnValue({
      ENABLE_PLATFORM_MANAGED_SKILLS: true,
    });
    managedSkillMocks.PlatformManagedResourcePolicyModel.mockImplementation(
      () => ({ getSnapshot }) as never,
    );
    managedSkillMocks.SkillCatalogReadService.mockImplementation(
      () => ({ resolvePinnedForExecution }) as never,
    );
    mockPreprocessLhCommand.mockResolvedValue({
      command: 'python scripts/run.py',
      isLhCommand: false,
      skipSkillLookup: false,
    });
    mockSandboxCallTool.mockResolvedValue({ result: { ok: true }, success: true });

    const caller = marketRouter.createCaller({
      serverDB: {},
      userId: 'user-1',
      workspaceId: 'workspace-1',
    } as any);
    await caller.execInSandbox({
      params: {
        activatedSkills: [{ name: 'managed.skill' }],
        command: 'python scripts/run.py',
        operationId: 'operation-1',
        platformSkillSnapshot: {
          mandatorySkillIds: ['managed.skill'],
          refs: [{ checksum, skillKey: 'managed.skill', version: '1.0.0' }],
          revision: 'catalog-r1',
        },
      },
      toolName: 'execScript',
      topicId: 'topic-1',
    });

    expect(resolvePinnedForExecution).toHaveBeenCalledWith({
      checksum,
      skillKey: 'managed.skill',
      version: '1.0.0',
    });
    expect(managedSkillMocks.AgentSkillModel).not.toHaveBeenCalled();
    expect(managedSkillMocks.FileModel).not.toHaveBeenCalled();
    expect(mockSandboxCallTool).toHaveBeenCalledWith(
      'writeFile',
      expect.objectContaining({
        content: 'print("ok")',
        path: expect.stringMatching(/\/a{64}\/scripts\/run\.py$/),
      }),
    );
    const execution = mockSandboxCallTool.mock.calls.find(
      ([toolName, callParams]) =>
        toolName === 'runCommand' && String(callParams.command).includes('python scripts/run.py'),
    );
    expect(execution?.[1]).not.toHaveProperty('platformSkillSnapshot');
    expect(execution?.[1]).not.toHaveProperty('operationId');
    expect(execution?.[1]).not.toHaveProperty('skillZipUrls');
    expect(mockSandboxCallTool).toHaveBeenCalledWith(
      'runCommand',
      expect.objectContaining({ command: expect.stringContaining('rm -rf') }),
    );
  });

  it('should fall back to static tools when live discovery fails', async () => {
    const caller = marketRouter.createCaller({ userId: 'user-1' } as any);
    mockMarketSDK.skills.listLiveTools.mockRejectedValue(new Error('Live discovery failed'));
    mockMarketSDK.skills.listTools.mockResolvedValue({
      tools: [
        {
          description: 'Run a PostHog query',
          inputSchema: { properties: { query: { type: 'string' } }, type: 'object' },
          name: 'query',
        },
      ],
    });

    await expect(caller.connectListTools({ provider: 'posthog' })).resolves.toEqual({
      provider: 'posthog',
      tools: [
        {
          description: 'Run a PostHog query',
          inputSchema: { properties: { query: { type: 'string' } }, type: 'object' },
          name: 'query',
        },
      ],
    });

    expect(mockMarketSDK.skills.listLiveTools).toHaveBeenCalledWith('posthog');
    expect(mockMarketSDK.skills.listTools).toHaveBeenCalledWith('posthog');
  });

  it('should preserve failed tool call error payloads', async () => {
    const caller = marketRouter.createCaller({ userId: 'user-1' } as any);
    mockMarketSDK.skills.callTool.mockResolvedValue({
      data: null,
      error: { code: 'POSTHOG_QUERY_FAILED', message: 'Query failed' },
      success: false,
    });

    await expect(
      caller.connectCallTool({
        args: { query: 'select * from events' },
        provider: 'posthog',
        toolName: 'query',
      }),
    ).resolves.toEqual({
      data: null,
      error: { code: 'POSTHOG_QUERY_FAILED', message: 'Query failed' },
      success: false,
    });

    expect(mockMarketSDK.skills.callTool).toHaveBeenCalledWith('posthog', {
      args: { query: 'select * from events' },
      tool: 'query',
      topicId: undefined,
    });
  });
});
