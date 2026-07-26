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
  AgentOperationModel: vi.fn(() => ({ findById: managedSkillMocks.findOperation })),
  assertUserActive: vi.fn(),
  debugLog: vi.fn(),
  FileModel: vi.fn(() => ({ checkHash: vi.fn() })),
  findOperation: vi.fn(),
  getRuntimeModeSnapshot: vi.fn(),
  SkillCatalogReadService: vi.fn(() => ({
    resolvePinnedForExecution: vi.fn(),
  })),
  parseEnterpriseFeatureFlags: vi.fn(() => ({ ENABLE_PLATFORM_MANAGED_SKILLS: false })),
  verifyProof: vi.fn(),
}));

vi.mock('@/database/models/agentSkill', () => ({
  AgentSkillModel: managedSkillMocks.AgentSkillModel,
}));

vi.mock('@/database/models/agentOperation', () => ({
  AgentOperationModel: managedSkillMocks.AgentOperationModel,
}));

vi.mock('@/database/models/file', () => ({
  FileModel: managedSkillMocks.FileModel,
}));

vi.mock('@/server/enterprise/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    parseEnterpriseFeatureFlags: managedSkillMocks.parseEnterpriseFeatureFlags,
  };
});

vi.mock('@/libs/oidc-provider/access-control', () => ({
  assertUserActive: managedSkillMocks.assertUserActive,
  isOIDCUserInactiveError: (error: unknown) =>
    Boolean(
      error &&
      typeof error === 'object' &&
      (error as { name?: string }).name === 'OIDCUserInactiveError',
    ),
}));

vi.mock('@/libs/trpc/utils/internalJwt', () => ({
  hashPlatformSkillOperationRefs: vi.fn(() => 'refs-hash'),
  verifyPlatformSkillOperationProof: managedSkillMocks.verifyProof,
}));

vi.mock('@/server/enterprise/services/skillCatalog', async () => {
  const lifecycle = await vi.importActual<Record<string, unknown>>(
    '@/server/enterprise/services/skillCatalog/sandboxWorkspaceLifecycle',
  );
  return {
    ...lifecycle,
    getBuiltinSkillDefinitions: vi.fn(() => []),
    SkillCatalogReadService: managedSkillMocks.SkillCatalogReadService,
  };
});

vi.mock('@/server/enterprise/services/managedResourceCapabilities', () => ({
  getManagedSkillRuntimeModeSnapshot: managedSkillMocks.getRuntimeModeSnapshot,
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
  default: vi.fn(() => managedSkillMocks.debugLog),
}));

describe('tools marketRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    managedSkillMocks.assertUserActive.mockResolvedValue(undefined);
    managedSkillMocks.parseEnterpriseFeatureFlags.mockReturnValue({
      ENABLE_PLATFORM_MANAGED_SKILLS: false,
    });
    managedSkillMocks.verifyProof.mockResolvedValue({
      agentId: 'agent-1',
      operationId: 'operation-1',
      refsHash: 'refs-hash',
      revision: 'catalog-r1',
      userId: 'user-1',
    });
    managedSkillMocks.findOperation.mockResolvedValue({
      agentId: 'agent-1',
      id: 'operation-1',
      status: 'running',
    });
    managedSkillMocks.getRuntimeModeSnapshot.mockReturnValue('unmanaged');
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
      agentId: 'agent-1',
      operationId: 'operation-1',
      params: {
        activatedSkills: [{ name: 'managed.skill' }],
        command: 'python scripts/run.py',
        operationId: 'operation-1',
        platformSkillSnapshot: {
          agentId: 'agent-1',
          mandatorySkillIds: ['managed.skill'],
          operationId: 'operation-1',
          proof: 'signed-proof',
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
    expect(managedSkillMocks.getRuntimeModeSnapshot).toHaveBeenCalledOnce();
    expect(managedSkillMocks.verifyProof).toHaveBeenCalledWith('signed-proof', 'user-1');
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
      expect.objectContaining({ command: expect.stringMatching(/^rm -rf '/) }),
    );
    const commands = mockSandboxCallTool.mock.calls
      .filter(([toolName]) => toolName === 'runCommand')
      .map(([, callParams]) => String(callParams.command));
    expect(commands.findIndex((command) => command.includes('-mmin +240'))).toBeLessThan(
      commands.findIndex((command) => command.startsWith('umask 077 && mkdir -p')),
    );
    const managedLogs = JSON.stringify(managedSkillMocks.debugLog.mock.calls);
    expect(managedLogs).not.toContain('print("ok")');
    expect(managedLogs).not.toContain('/tmp/lobe-managed-skills');

    await expect(
      caller.execInSandbox({
        agentId: 'other-agent',
        operationId: 'operation-1',
        params: {
          activatedSkills: [{ name: 'managed.skill' }],
          command: 'python scripts/run.py',
          operationId: 'operation-1',
          platformSkillSnapshot: {
            agentId: 'agent-1',
            operationId: 'operation-1',
            proof: 'signed-proof',
            refs: [{ checksum, skillKey: 'managed.skill', version: '1.0.0' }],
            revision: 'catalog-r1',
          },
        },
        toolName: 'execScript',
        topicId: 'topic-1',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects proof A when the persisted runtime operation belongs to agent B', async () => {
    const checksum = 'a'.repeat(64);
    managedSkillMocks.parseEnterpriseFeatureFlags.mockReturnValue({
      ENABLE_PLATFORM_MANAGED_SKILLS: true,
    });
    managedSkillMocks.findOperation.mockResolvedValue({
      agentId: 'agent-b',
      id: 'operation-1',
      status: 'running',
    });
    mockPreprocessLhCommand.mockResolvedValue({
      command: 'true',
      isLhCommand: false,
      skipSkillLookup: false,
    });
    const caller = marketRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

    await expect(
      caller.execInSandbox({
        agentId: 'agent-1',
        operationId: 'operation-1',
        params: {
          activatedSkills: [{ name: 'managed.skill' }],
          command: 'true',
          operationId: 'operation-1',
          platformSkillSnapshot: {
            agentId: 'agent-1',
            operationId: 'operation-1',
            proof: 'signed-proof',
            refs: [{ checksum, skillKey: 'managed.skill', version: '1.0.0' }],
            revision: 'catalog-r1',
          },
        },
        toolName: 'execScript',
        topicId: 'topic-1',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(managedSkillMocks.SkillCatalogReadService).not.toHaveBeenCalled();
    expect(managedSkillMocks.AgentSkillModel).not.toHaveBeenCalled();
  });

  it('rejects a previously signed managed snapshot after the feature is disabled', async () => {
    const checksum = 'a'.repeat(64);
    mockPreprocessLhCommand.mockResolvedValue({
      command: 'true',
      isLhCommand: false,
      skipSkillLookup: false,
    });
    const caller = marketRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

    await expect(
      caller.execInSandbox({
        agentId: 'agent-1',
        operationId: 'operation-1',
        params: {
          activatedSkills: [{ name: 'managed.skill' }],
          command: 'true',
          operationId: 'operation-1',
          platformSkillSnapshot: {
            agentId: 'agent-1',
            operationId: 'operation-1',
            proof: 'signed-proof',
            refs: [{ checksum, skillKey: 'managed.skill', version: '1.0.0' }],
            revision: 'catalog-r1',
          },
        },
        toolName: 'execScript',
        topicId: 'topic-1',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(managedSkillMocks.SkillCatalogReadService).not.toHaveBeenCalled();
    expect(managedSkillMocks.AgentSkillModel).not.toHaveBeenCalled();
  });

  it('rejects a valid managed snapshot with no activated Skills', async () => {
    managedSkillMocks.parseEnterpriseFeatureFlags.mockReturnValue({
      ENABLE_PLATFORM_MANAGED_SKILLS: true,
    });
    mockPreprocessLhCommand.mockResolvedValue({
      command: 'true',
      isLhCommand: false,
      skipSkillLookup: false,
    });
    const caller = marketRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

    await expect(
      caller.execInSandbox({
        agentId: 'agent-1',
        operationId: 'operation-1',
        params: {
          activatedSkills: [],
          command: 'true',
          operationId: 'operation-1',
          platformSkillSnapshot: {
            agentId: 'agent-1',
            operationId: 'operation-1',
            proof: 'signed-proof',
            refs: [],
            revision: 'catalog-r1',
          },
        },
        toolName: 'execScript',
        topicId: 'topic-1',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(managedSkillMocks.SkillCatalogReadService).not.toHaveBeenCalled();
  });

  it('redacts managed materialization errors and never logs resource paths', async () => {
    const checksum = 'a'.repeat(64);
    managedSkillMocks.parseEnterpriseFeatureFlags.mockReturnValue({
      ENABLE_PLATFORM_MANAGED_SKILLS: true,
    });
    managedSkillMocks.SkillCatalogReadService.mockImplementation(
      () =>
        ({
          resolvePinnedForExecution: vi.fn().mockResolvedValue({
            checksum,
            content: '# secret managed content',
            contentRef: null,
            resources: [
              {
                checksum: 'b'.repeat(64),
                content: 'Bearer super-secret-token',
                mediaType: 'text/plain',
                path: '/tmp/private-resource.txt',
                sizeBytes: 25,
              },
            ],
            skillKey: 'managed.skill',
            version: '1.0.0',
          }),
        }) as never,
    );
    mockPreprocessLhCommand.mockResolvedValue({
      command: 'true',
      isLhCommand: false,
      skipSkillLookup: false,
    });
    const caller = marketRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

    await expect(
      caller.execInSandbox({
        agentId: 'agent-1',
        operationId: 'operation-1',
        params: {
          activatedSkills: [{ name: 'managed.skill' }],
          command: 'true',
          operationId: 'operation-1',
          platformSkillSnapshot: {
            agentId: 'agent-1',
            operationId: 'operation-1',
            proof: 'signed-proof',
            refs: [{ checksum, skillKey: 'managed.skill', version: '1.0.0' }],
            revision: 'catalog-r1',
          },
        },
        toolName: 'execScript',
        topicId: 'topic-1',
      }),
    ).resolves.toMatchObject({
      error: {
        message:
          'This Skill couldn’t run. Start a new run and try again. If the problem continues, contact your administrator.',
      },
      success: false,
    });
    const logs = JSON.stringify(managedSkillMocks.debugLog.mock.calls);
    expect(logs).not.toContain('private-resource');
    expect(logs).not.toContain('super-secret-token');
    expect(logs).not.toContain('secret managed content');
  });

  it('retries a failed managed cloud workspace cleanup', async () => {
    const checksum = 'a'.repeat(64);
    managedSkillMocks.parseEnterpriseFeatureFlags.mockReturnValue({
      ENABLE_PLATFORM_MANAGED_SKILLS: true,
    });
    managedSkillMocks.SkillCatalogReadService.mockImplementation(
      () =>
        ({
          resolvePinnedForExecution: vi.fn().mockResolvedValue({
            checksum,
            content: '# exact managed content',
            contentRef: null,
            resources: [],
            skillKey: 'managed.skill',
            version: '1.0.0',
          }),
        }) as never,
    );
    mockPreprocessLhCommand.mockResolvedValue({
      command: 'true',
      isLhCommand: false,
      skipSkillLookup: false,
    });
    mockSandboxCallTool.mockImplementation(async (toolName: string, params: Record<string, any>) =>
      toolName === 'runCommand' && String(params.command).startsWith('rm -rf ')
        ? { error: { message: 'cleanup deferred' }, success: false }
        : { result: { exitCode: 0 }, success: true },
    );

    const caller = marketRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);
    await expect(
      caller.execInSandbox({
        agentId: 'agent-1',
        operationId: 'operation-1',
        params: {
          activatedSkills: [{ name: 'managed.skill' }],
          command: 'true',
          operationId: 'operation-1',
          platformSkillSnapshot: {
            agentId: 'agent-1',
            mandatorySkillIds: ['managed.skill'],
            operationId: 'operation-1',
            proof: 'signed-proof',
            refs: [{ checksum, skillKey: 'managed.skill', version: '1.0.0' }],
            revision: 'catalog-r1',
          },
        },
        toolName: 'execScript',
        topicId: 'topic-1',
      }),
    ).resolves.toMatchObject({ success: true });

    const cleanups = mockSandboxCallTool.mock.calls.filter(
      ([toolName, params]) =>
        toolName === 'runCommand' && String(params.command).startsWith('rm -rf '),
    );
    expect(cleanups).toHaveLength(2);
  });

  it('fails closed in enforced mode when no verified operation snapshot exists', async () => {
    managedSkillMocks.parseEnterpriseFeatureFlags.mockReturnValue({
      ENABLE_PLATFORM_MANAGED_SKILLS: true,
    });
    managedSkillMocks.getRuntimeModeSnapshot.mockReturnValue('enforced');
    mockPreprocessLhCommand.mockResolvedValue({
      command: 'python scripts/run.py',
      isLhCommand: false,
      skipSkillLookup: false,
    });
    const caller = marketRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

    await expect(
      caller.execInSandbox({
        params: {
          activatedSkills: [{ name: 'managed.skill' }],
          command: 'python scripts/run.py',
          operationId: 'operation-1',
        },
        toolName: 'execScript',
        topicId: 'topic-1',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(managedSkillMocks.AgentSkillModel).not.toHaveBeenCalled();
  });

  it.each([undefined, []])(
    'fails closed in enforced mode when activatedSkills is %s',
    async (activatedSkills) => {
      managedSkillMocks.parseEnterpriseFeatureFlags.mockReturnValue({
        ENABLE_PLATFORM_MANAGED_SKILLS: true,
      });
      managedSkillMocks.getRuntimeModeSnapshot.mockReturnValue('enforced');
      mockPreprocessLhCommand.mockResolvedValue({
        command: 'python scripts/run.py',
        isLhCommand: false,
        skipSkillLookup: false,
      });
      const caller = marketRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

      await expect(
        caller.execInSandbox({
          params: {
            ...(activatedSkills === undefined ? {} : { activatedSkills }),
            command: 'python scripts/run.py',
          },
          toolName: 'execScript',
          topicId: 'topic-1',
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(managedSkillMocks.getRuntimeModeSnapshot).toHaveBeenCalledOnce();
      expect(managedSkillMocks.AgentSkillModel).not.toHaveBeenCalled();
    },
  );

  it.each(['observe', 'ui-only'])(
    'keeps the legacy ZIP path in %s mode when no operation snapshot exists',
    async (mode) => {
      managedSkillMocks.parseEnterpriseFeatureFlags.mockReturnValue({
        ENABLE_PLATFORM_MANAGED_SKILLS: true,
      });
      managedSkillMocks.getRuntimeModeSnapshot.mockReturnValue(mode);
      mockPreprocessLhCommand.mockResolvedValue({
        command: 'python scripts/run.py',
        isLhCommand: false,
        skipSkillLookup: false,
      });
      mockSandboxCallTool.mockResolvedValue({ result: { exitCode: 0 }, success: true });
      const caller = marketRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

      await caller.execInSandbox({
        params: {
          activatedSkills: [{ name: 'personal.skill' }],
          command: 'python scripts/run.py',
          operationId: 'operation-1',
        },
        toolName: 'execScript',
        topicId: 'topic-1',
      });

      expect(managedSkillMocks.AgentSkillModel).toHaveBeenCalled();
      expect(managedSkillMocks.SkillCatalogReadService).not.toHaveBeenCalled();
    },
  );

  it('rejects oversized activatedSkills before any catalog I/O (SR-002)', async () => {
    const checksum = 'a'.repeat(64);
    const resolvePinnedForExecution = vi.fn();
    managedSkillMocks.parseEnterpriseFeatureFlags.mockReturnValue({
      ENABLE_PLATFORM_MANAGED_SKILLS: true,
    });
    managedSkillMocks.SkillCatalogReadService.mockImplementation(
      () => ({ resolvePinnedForExecution }) as never,
    );
    mockPreprocessLhCommand.mockResolvedValue({
      command: 'true',
      isLhCommand: false,
      skipSkillLookup: false,
    });
    const caller = marketRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

    await expect(
      caller.execInSandbox({
        agentId: 'agent-1',
        operationId: 'operation-1',
        params: {
          activatedSkills: Array.from({ length: 101 }, (_, i) => ({ name: `skill-${i}` })),
          command: 'true',
          operationId: 'operation-1',
          platformSkillSnapshot: {
            agentId: 'agent-1',
            operationId: 'operation-1',
            proof: 'signed-proof',
            refs: [{ checksum, skillKey: 'managed.skill', version: '1.0.0' }],
            revision: 'catalog-r1',
          },
        },
        toolName: 'execScript',
        topicId: 'topic-1',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(resolvePinnedForExecution).not.toHaveBeenCalled();
    expect(managedSkillMocks.SkillCatalogReadService).not.toHaveBeenCalled();
    expect(mockCreateSandboxService).not.toHaveBeenCalled();
  });

  it('collapses duplicate activatedSkills by name before catalog I/O (SR-002 / R3)', async () => {
    const checksum = 'a'.repeat(64);
    const resolvePinnedForExecution = vi.fn().mockResolvedValue({
      checksum,
      content: '# ok',
      contentRef: null,
      resources: [],
      skillKey: 'managed.skill',
      version: '1.0.0',
    });
    managedSkillMocks.parseEnterpriseFeatureFlags.mockReturnValue({
      ENABLE_PLATFORM_MANAGED_SKILLS: true,
    });
    managedSkillMocks.SkillCatalogReadService.mockImplementation(
      () => ({ resolvePinnedForExecution }) as never,
    );
    mockPreprocessLhCommand.mockResolvedValue({
      command: 'true',
      isLhCommand: false,
      skipSkillLookup: false,
    });
    mockSandboxCallTool.mockResolvedValue({ result: { exitCode: 0 }, success: true });
    const caller = marketRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

    // Same name with and without id is a legitimate activation list (DB + filesystem skill).
    await expect(
      caller.execInSandbox({
        agentId: 'agent-1',
        operationId: 'operation-1',
        params: {
          activatedSkills: [{ id: 'db-skill-1', name: 'managed.skill' }, { name: 'managed.skill' }],
          command: 'true',
          operationId: 'operation-1',
          platformSkillSnapshot: {
            agentId: 'agent-1',
            operationId: 'operation-1',
            proof: 'signed-proof',
            refs: [{ checksum, skillKey: 'managed.skill', version: '1.0.0' }],
            revision: 'catalog-r1',
          },
        },
        toolName: 'execScript',
        topicId: 'topic-1',
      }),
    ).resolves.toMatchObject({ success: true });
    // Collapsed to one resolve — not a hard BAD_REQUEST kill of the step.
    expect(resolvePinnedForExecution).toHaveBeenCalledTimes(1);
  });

  describe('active-user revocation on sandbox execution (SR-001 / SR-005)', () => {
    // Wiring-only: assertUserActive is mocked (speed). Full banned/temp-ban/epoch matrix
    // lives on resolvePlatformPinned with real DB rows (see agentSkills.resolvePlatformPinned.test.ts).
    const inactiveError = () => {
      const error = new Error('user inactive');
      error.name = 'OIDCUserInactiveError';
      return error;
    };

    const managedExecInput = {
      agentId: 'agent-1',
      operationId: 'operation-1',
      params: {
        activatedSkills: [{ name: 'managed.skill' }],
        command: 'true',
        operationId: 'operation-1',
        platformSkillSnapshot: {
          agentId: 'agent-1',
          operationId: 'operation-1',
          proof: 'signed-proof',
          refs: [{ checksum: 'a'.repeat(64), skillKey: 'managed.skill', version: '1.0.0' }],
          revision: 'catalog-r1',
        },
      },
      toolName: 'execScript' as const,
      topicId: 'topic-1',
    };

    it.each([['execInSandbox'] as const, ['callCodeInterpreterTool'] as const])(
      'rejects an inactive principal on %s before proof/sandbox work (middleware wiring)',
      async (procedure) => {
        vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
        managedSkillMocks.assertUserActive.mockRejectedValue(inactiveError());
        managedSkillMocks.parseEnterpriseFeatureFlags.mockReturnValue({
          ENABLE_PLATFORM_MANAGED_SKILLS: true,
        });
        const caller = marketRouter.createCaller({
          credentialIssuedAt: new Date('2020-01-01T00:00:00.000Z'),
          serverDB: {},
          userId: 'user-1',
        } as any);

        await expect(caller[procedure](managedExecInput)).rejects.toMatchObject({
          code: 'UNAUTHORIZED',
        });
        expect(managedSkillMocks.assertUserActive).toHaveBeenCalled();
        expect(managedSkillMocks.verifyProof).not.toHaveBeenCalled();
        expect(managedSkillMocks.SkillCatalogReadService).not.toHaveBeenCalled();
        expect(mockCreateSandboxService).not.toHaveBeenCalled();
        expect(mockSandboxCallTool).not.toHaveBeenCalled();
      },
    );

    it('allows an active principal when managed Skills are enabled', async () => {
      vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
      managedSkillMocks.assertUserActive.mockResolvedValue(undefined);
      managedSkillMocks.parseEnterpriseFeatureFlags.mockReturnValue({
        ENABLE_PLATFORM_MANAGED_SKILLS: true,
      });
      const resolvePinnedForExecution = vi.fn().mockResolvedValue({
        checksum: 'a'.repeat(64),
        content: '# ok',
        contentRef: null,
        resources: [],
        skillKey: 'managed.skill',
        version: '1.0.0',
      });
      managedSkillMocks.SkillCatalogReadService.mockImplementation(
        () => ({ resolvePinnedForExecution }) as never,
      );
      mockPreprocessLhCommand.mockResolvedValue({
        command: 'true',
        isLhCommand: false,
        skipSkillLookup: false,
      });
      mockSandboxCallTool.mockResolvedValue({ result: { exitCode: 0 }, success: true });
      const caller = marketRouter.createCaller({
        credentialIssuedAt: new Date(),
        serverDB: {},
        userId: 'user-1',
      } as any);

      await expect(caller.execInSandbox(managedExecInput)).resolves.toMatchObject({
        success: true,
      });
      expect(managedSkillMocks.assertUserActive).toHaveBeenCalled();
      expect(resolvePinnedForExecution).toHaveBeenCalled();
    });

    it('skips active-user enforcement when the managed Skills flag is off', async () => {
      vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '0');
      mockPreprocessLhCommand.mockResolvedValue({
        command: 'true',
        isLhCommand: false,
        skipSkillLookup: false,
      });
      mockSandboxCallTool.mockResolvedValue({ result: { exitCode: 0 }, success: true });
      const caller = marketRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

      await expect(
        caller.execInSandbox({
          params: { command: 'true' },
          toolName: 'runCommand',
          topicId: 'topic-1',
        }),
      ).resolves.toMatchObject({ success: true });
      expect(managedSkillMocks.assertUserActive).not.toHaveBeenCalled();
    });
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
