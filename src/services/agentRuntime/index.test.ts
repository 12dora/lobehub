import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentRuntimeService } from './index';

const mutate = vi.hoisted(() => vi.fn());

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    aiAgent: {
      processHumanIntervention: { mutate },
    },
  },
}));

describe('AgentRuntimeService.handleHumanIntervention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the persisted tool-message target at the router-required top level', async () => {
    const data = {
      approvedToolCall: {
        apiName: 'search',
        arguments: '{}',
        id: 'tool-call-1',
        identifier: 'web-search',
        type: 'default',
      },
    };
    mutate.mockResolvedValue({ queued: true });

    await agentRuntimeService.handleHumanIntervention({
      action: 'approve',
      data,
      operationId: 'operation-1',
      toolMessageId: 'tool-msg-1',
    });

    expect(mutate).toHaveBeenCalledWith({
      action: 'approve',
      data,
      operationId: 'operation-1',
      reason: undefined,
      stepIndex: 0,
      toolMessageId: 'tool-msg-1',
    });
  });
});
