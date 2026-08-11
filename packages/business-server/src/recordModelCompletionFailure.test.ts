import { beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.fn();

vi.mock('debug', () => ({ default: () => log }));

const { recordModelCompletionFailure } = await import('./recordModelCompletionFailure');

describe('recordModelCompletionFailure', () => {
  beforeEach(() => {
    log.mockReset();
  });

  it('writes a structured operation-correlated breadcrumb without payload evidence', async () => {
    const request = { messages: [{ content: 'private prompt' }] };
    const response = { content: 'private response' };

    await recordModelCompletionFailure({
      attempt: 1,
      maxAttempts: 2,
      model: 'test-model',
      operationId: 'op-test',
      operationLogId: 'op-log-test',
      provider: 'test-provider',
      reason: 'empty_completion',
      request,
      response,
      stepIndex: 3,
      topicId: 'topic-test',
      userId: 'user-test',
      workspaceId: 'workspace-test',
    });

    expect(log).toHaveBeenCalledWith('[%s][%d] model completion failure: %O', 'op-log-test', 3, {
      attempt: 1,
      maxAttempts: 2,
      model: 'test-model',
      operationId: 'op-test',
      provider: 'test-provider',
      reason: 'empty_completion',
      topicId: 'topic-test',
      workspaceId: 'workspace-test',
    });
    expect(log.mock.calls.flat()).not.toContain(request);
    expect(log.mock.calls.flat()).not.toContain(response);
  });

  it('never throws when the debug sink fails', async () => {
    log.mockImplementationOnce(() => {
      throw new Error('debug sink failed');
    });

    await expect(
      recordModelCompletionFailure({
        attempt: 1,
        maxAttempts: 1,
        model: 'test-model',
        operationId: 'op-test',
        operationLogId: 'op-log-test',
        provider: 'test-provider',
        reason: 'refusal',
        request: {},
        response: {},
        stepIndex: 0,
      }),
    ).resolves.toBeUndefined();
  });
});
