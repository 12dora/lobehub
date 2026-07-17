import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findAll: vi.fn(),
  findById: vi.fn(),
  findByName: vi.fn(),
  getAgentConfigById: vi.fn(),
  platformFindByName: vi.fn(),
}));

vi.mock('@lobechat/builtin-skills', () => ({
  builtinSkills: [],
}));

vi.mock('@/database/models/agent', () => ({
  AgentModel: vi.fn(() => ({
    getAgentConfigById: mocks.getAgentConfigById,
  })),
}));

vi.mock('@/database/models/agentSkill', () => ({
  AgentSkillModel: vi.fn(() => ({
    findAll: mocks.findAll,
    findById: mocks.findById,
    findByName: mocks.findByName,
  })),
}));

vi.mock('@/helpers/skillFilters', () => ({
  filterBuiltinSkills: vi.fn((skills: unknown) => skills),
}));

vi.mock('@/server/enterprise/services/skillCatalog', () => ({
  createPlatformSkillOperationResolver: vi.fn(() => ({
    findAll: vi.fn(),
    findById: vi.fn(),
    findByName: mocks.platformFindByName,
    readResource: vi.fn(),
  })),
}));

vi.mock('@/server/services/agentSignal/procedure', () => ({
  emitToolOutcomeSafely: vi.fn().mockResolvedValue(undefined),
  resolveToolOutcomeScope: vi.fn(() => ({ scope: 'agent', scopeKey: 'agent-1' })),
}));

vi.mock('@/server/services/agentSignal/store/adapters/redis/policyStateStore', () => ({
  redisPolicyStateStore: {},
}));

describe('activatorRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgentConfigById.mockResolvedValue({ plugins: [] });
    mocks.findAll.mockResolvedValue({ data: [], total: 0 });
    mocks.findById.mockResolvedValue(undefined);
    mocks.findByName.mockResolvedValue(undefined);
    mocks.platformFindByName.mockResolvedValue(undefined);
  });

  describe('activateSkill — disabled skill enforcement', () => {
    // First dynamic `import('../activator')` in the file pays the real
    // transform cost for this module — default 5s timeout is marginal for
    // that cold cost alone, independent of test logic.
    it('refuses to activate a DB skill the agent has disabled, even though it exists', async () => {
      mocks.getAgentConfigById.mockResolvedValue({
        plugins: [{ identifier: 'user-skill-identifier', mode: 'disabled' }],
      });
      mocks.findByName.mockImplementation(async (name: string) =>
        name === 'user-skill'
          ? {
              content: '# User skill',
              id: 'user-skill-id',
              identifier: 'user-skill-identifier',
              name: 'user-skill',
            }
          : undefined,
      );

      const { activatorRuntime } = await import('../activator');
      const runtime = await activatorRuntime.factory({
        agentId: 'agent-1',
        serverDB: {} as never,
        toolManifestMap: {},
        userId: 'user-1',
      });

      const result = await runtime.activateSkill({ name: 'user-skill' });

      expect(result.success).toBe(false);
    }, 20_000);

    it('still activates the skill when it is not disabled', async () => {
      mocks.getAgentConfigById.mockResolvedValue({ plugins: [] });
      mocks.findByName.mockImplementation(async (name: string) =>
        name === 'user-skill'
          ? {
              content: '# User skill',
              id: 'user-skill-id',
              identifier: 'user-skill-identifier',
              name: 'user-skill',
            }
          : undefined,
      );

      const { activatorRuntime } = await import('../activator');
      const runtime = await activatorRuntime.factory({
        agentId: 'agent-1',
        serverDB: {} as never,
        toolManifestMap: {},
        userId: 'user-1',
      });

      const result = await runtime.activateSkill({ name: 'user-skill' });

      expect(result.success).toBe(true);
    });
  });

  it('uses only the pinned platform resolver for a managed operation snapshot', async () => {
    mocks.platformFindByName.mockResolvedValue({
      content: '# Managed',
      id: 'platform-skill:managed.skill',
      identifier: 'managed.skill',
      name: 'managed.skill',
      resources: {},
    });
    const { activatorRuntime } = await import('../activator');
    const runtime = await activatorRuntime.factory({
      agentId: 'agent-1',
      operationSkillSet: {
        enabledPluginIds: [],
        platformCatalog: {
          refs: [{ checksum: 'a'.repeat(64), skillKey: 'managed.skill', version: '1.0.0' }],
          revision: 'r1',
        },
        skills: [],
      },
      serverDB: {} as never,
      toolManifestMap: {},
      userId: 'user-1',
    });

    await expect(runtime.activateSkill({ name: 'managed.skill' })).resolves.toMatchObject({
      content: '# Managed',
      success: true,
    });
    expect(mocks.platformFindByName).toHaveBeenCalledWith('managed.skill');
    expect(mocks.getAgentConfigById).not.toHaveBeenCalled();
    expect(mocks.findByName).not.toHaveBeenCalled();
  });
});
