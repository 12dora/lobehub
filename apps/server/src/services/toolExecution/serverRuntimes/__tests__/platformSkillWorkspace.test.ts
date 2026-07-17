import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ManagedSkillServerRuntimeService } from '../platformSkillWorkspace';

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  cleanupInlineSkillWorkspace: vi.fn(),
  executeToolCall: vi.fn(),
  prepareInlineSkillWorkspace: vi.fn(),
  resolvePinnedForExecution: vi.fn(),
}));

vi.mock('@/server/enterprise/services/skillCatalog', async () => {
  const lifecycle = await vi.importActual<Record<string, unknown>>(
    '@/server/enterprise/services/skillCatalog/sandboxWorkspaceLifecycle',
  );
  return {
    ...lifecycle,
    getBuiltinSkillDefinitions: vi.fn(() => []),
    PlatformSkillOperationResolver: vi.fn(() => ({
      findAll: vi.fn(async () => ({ data: [], total: 0 })),
      findById: vi.fn(),
      findByName: vi.fn(),
      readResource: vi.fn(),
    })),
    SkillCatalogReadService: vi.fn(() => ({
      resolvePinnedForExecution: mocks.resolvePinnedForExecution,
    })),
  };
});

vi.mock('@/server/services/deviceGateway', () => ({
  deviceGateway: {
    cleanupInlineSkillWorkspace: mocks.cleanupInlineSkillWorkspace,
    executeToolCall: mocks.executeToolCall,
    prepareInlineSkillWorkspace: mocks.prepareInlineSkillWorkspace,
  },
}));

vi.mock('@/server/services/market', () => ({ MarketService: vi.fn() }));
vi.mock('@/server/services/sandbox', async () => {
  const actual = await vi.importActual('@/server/services/sandbox');
  return {
    ...(actual as Record<string, unknown>),
    createSandboxService: vi.fn(() => ({ callTool: mocks.callTool })),
  };
});

const checksum = 'a'.repeat(64);
const snapshot = {
  agentId: 'agent-1',
  mandatorySkillIds: ['managed.skill'],
  operationId: 'operation-1',
  refs: [{ checksum, skillKey: 'managed.skill', version: '1.0.0' }],
  revision: 'catalog-r1',
};
const resolved = {
  checksum,
  content: '# Managed',
  contentRef: null,
  manifest: { description: 'Managed' },
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
};

const createRuntime = (activeDeviceId?: string) =>
  new ManagedSkillServerRuntimeService({
    activeDeviceId,
    agentId: 'agent-1',
    operationId: 'operation-1',
    serverDB: {} as never,
    snapshot,
    topicId: 'topic-1',
    userId: 'user-1',
  });

describe('ManagedSkillServerRuntimeService workspace lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePinnedForExecution.mockResolvedValue(resolved);
    mocks.callTool.mockResolvedValue({
      result: { exitCode: 0, output: 'ok', success: true },
      success: true,
    });
  });

  it('cleans partially written sandbox files when a resource write fails', async () => {
    mocks.callTool.mockImplementation(async (toolName: string, params: Record<string, unknown>) =>
      toolName === 'writeFile' && String(params.path).endsWith('/scripts/run.py')
        ? { error: { message: 'write failed' }, success: false }
        : { result: { exitCode: 0, output: '', success: true }, success: true },
    );

    await expect(
      createRuntime().execScript('python scripts/run.py', {
        activatedSkills: [{ name: 'managed.skill' }],
        description: 'run',
      }),
    ).resolves.toMatchObject({ stderr: 'write failed', success: false });
    expect(mocks.callTool).toHaveBeenLastCalledWith(
      'runCommand',
      expect.objectContaining({ command: expect.stringMatching(/^rm -rf '/) }),
    );
  });

  it('isolates concurrent calls in unique directories and cleans each independently', async () => {
    const runtime = createRuntime();
    await Promise.all([
      runtime.execScript('python scripts/run.py', {
        activatedSkills: [{ name: 'managed.skill' }],
        description: 'first',
      }),
      runtime.execScript('python scripts/run.py', {
        activatedSkills: [{ name: 'managed.skill' }],
        description: 'second',
      }),
    ]);

    const roots = mocks.callTool.mock.calls
      .filter(
        ([toolName, params]) =>
          toolName === 'runCommand' && String(params.command).startsWith('umask 077 && mkdir -p'),
      )
      .map(([, params]) => String(params.command).match(/mkdir -p '([^']+)'/)?.[1]);
    expect(roots).toHaveLength(2);
    expect(new Set(roots).size).toBe(2);
    const cleanups = mocks.callTool.mock.calls.filter(
      ([toolName, params]) =>
        toolName === 'runCommand' && String(params.command).startsWith('rm -rf '),
    );
    expect(cleanups).toHaveLength(2);
    expect(cleanups.map(([, params]) => String(params.command))).toEqual(
      expect.arrayContaining(roots.map((root) => expect.stringContaining(root!))),
    );
  });

  it('retries a rejected sandbox cleanup without changing the command result', async () => {
    mocks.callTool.mockImplementation(async (toolName: string, params: Record<string, unknown>) =>
      toolName === 'runCommand' && String(params.command).startsWith('rm -rf ')
        ? { error: { message: 'cleanup deferred' }, success: false }
        : { result: { exitCode: 0, output: 'ok', success: true }, success: true },
    );

    await expect(
      createRuntime().execScript('python scripts/run.py', {
        activatedSkills: [{ name: 'managed.skill' }],
        description: 'run',
      }),
    ).resolves.toMatchObject({ success: true });

    const cleanups = mocks.callTool.mock.calls.filter(
      ([toolName, params]) =>
        toolName === 'runCommand' && String(params.command).startsWith('rm -rf '),
    );
    expect(cleanups).toHaveLength(2);
  });

  it('sweeps bounded expired workspaces before creating a new sandbox workspace', async () => {
    await createRuntime().execScript('python scripts/run.py', {
      activatedSkills: [{ name: 'managed.skill' }],
      description: 'run',
    });

    const commands = mocks.callTool.mock.calls
      .filter(([toolName]) => toolName === 'runCommand')
      .map(([, params]) => String(params.command));
    expect(commands[0]).toContain('-mmin +240');
    expect(commands[0]).toContain('"$count" -lt 32');
    expect(commands[1]).toMatch(/^umask 077 && mkdir -p/);
    expect(commands.some((command) => command.includes('find -P'))).toBe(true);
    expect(commands.some((command) => command.includes('stat -c %u'))).toBe(true);
  });

  it('cleans the device workspace when command delivery fails', async () => {
    mocks.prepareInlineSkillWorkspace.mockResolvedValue({
      success: true,
      workspaceDir: '/private/workspace',
      workspaceId: 'workspace-1',
    });
    mocks.executeToolCall.mockRejectedValue(new Error('device offline'));

    await expect(
      createRuntime('device-1').execScript('python scripts/run.py', {
        activatedSkills: [{ name: 'managed.skill' }],
        description: 'run',
      }),
    ).resolves.toMatchObject({ stderr: 'device offline', success: false });
    expect(mocks.cleanupInlineSkillWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-1' }),
    );
  });
});
