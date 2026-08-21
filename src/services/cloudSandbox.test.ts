import { beforeEach, describe, expect, it, vi } from 'vitest';

const mutate = vi.fn(async (input: unknown) => input);

vi.mock('@/libs/trpc/client', () => ({
  toolsClient: {
    market: {
      execInSandbox: { mutate },
      exportAndUploadFile: { mutate: vi.fn() },
    },
  },
}));

describe('cloudSandboxService', () => {
  beforeEach(() => {
    mutate.mockClear();
  });

  it('does not send userId on execInSandbox; identity is the session', async () => {
    const { cloudSandboxService } = await import('./cloudSandbox');

    await cloudSandboxService.callTool(
      'runCommand',
      { command: 'true' },
      { topicId: 'topic-1', agentId: 'agent-1' },
    );

    expect(mutate).toHaveBeenCalledWith({
      agentId: 'agent-1',
      operationId: undefined,
      params: { command: 'true' },
      toolName: 'runCommand',
      topicId: 'topic-1',
    });
    expect(mutate.mock.calls[0][0]).not.toHaveProperty('userId');
  });
});
