import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lobechat/builtin-skills', () => ({ builtinSkills: [] }));
vi.mock('@lobechat/builtin-tool-skills/executionRuntime', () => ({
  SkillsExecutionRuntime: class {
    constructor() {}
  },
}));
vi.mock('@lobechat/builtin-tool-skills/executor', () => ({
  SkillsExecutor: class {
    constructor() {}
  },
}));
vi.mock('@/helpers/skillFilters', () => ({ filterBuiltinSkills: (v: unknown) => v }));
vi.mock('@/services/electron/desktopSkillRuntime', () => ({
  desktopSkillRuntimeService: {
    cleanupExecutionWorkspace: vi.fn(),
    prepareExecutionWorkspace: vi.fn(),
    resolveReferenceFullPath: vi.fn(),
  },
}));
vi.mock('@/services/electron/localFileService', () => ({
  localFileService: { runCommand: vi.fn() },
}));
vi.mock('@/services/platformSkillRuntime', () => ({
  createClientSkillRuntimeService: () => ({}),
}));

const { withDesktopSkillWorkspaceCleanup } = await import('../lobe-skills.desktop');

describe('withDesktopSkillWorkspaceCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the successful command result when cleanup rejects', async () => {
    const cleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error('file locked'))
      .mockRejectedValueOnce(new Error('still locked'));
    const result = await withDesktopSkillWorkspaceCleanup(cleanup, async () => ({
      exitCode: 0,
      output: 'ok',
      success: true,
    }));

    expect(result).toEqual({ exitCode: 0, output: 'ok', success: true });
    // Primary failure path: best-effort retry still runs.
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('rethrows the original command error when cleanup also rejects', async () => {
    const commandError = new Error('script failed');
    const cleanup = vi.fn().mockRejectedValue(new Error('file locked'));

    await expect(
      withDesktopSkillWorkspaceCleanup(cleanup, async () => {
        throw commandError;
      }),
    ).rejects.toBe(commandError);

    expect(cleanup).toHaveBeenCalled();
  });

  it('returns the command result when cleanup succeeds', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const result = await withDesktopSkillWorkspaceCleanup(cleanup, async () => 'done');
    expect(result).toBe('done');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
