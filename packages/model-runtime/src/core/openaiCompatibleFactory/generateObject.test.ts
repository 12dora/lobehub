// @vitest-environment node
import { AgentRuntimeErrorType } from '@lobechat/types';
import OpenAI from 'openai';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenAICompatibleRuntime, isResponseFormatUnsupportedError } from './index';

// Pricing lookup reaches into model-bank's async provider loading, which is
// irrelevant to these tests (and unavailable in some monorepo test setups).
vi.mock('../../utils/getModelPricing', () => ({
  getModelPricing: vi.fn().mockResolvedValue(undefined),
}));

const TestRuntime = createOpenAICompatibleRuntime({
  baseURL: 'https://api.test.com/v1',
  provider: 'testprovider',
});

const generateObjectPayload = {
  messages: [{ content: 'Generate a handoff', role: 'user' as const }],
  model: 'gpt-anything',
  schema: {
    name: 'task_topic_handoff',
    schema: {
      additionalProperties: false,
      properties: { summary: { type: 'string' }, title: { type: 'string' } },
      required: ['title', 'summary'],
      type: 'object' as const,
    },
  },
};

const toolCallResponse = {
  choices: [
    {
      message: {
        tool_calls: [
          {
            function: {
              arguments: '{"summary":"Task completed","title":"Done"}',
              name: 'task_topic_handoff',
            },
            id: 'call_1',
            type: 'function',
          },
        ],
      },
    },
  ],
};

const responseFormatUnsupportedError = Object.assign(
  new Error('400 Error from provider (DeepSeek): This response_format type is unavailable now'),
  { status: 400 },
);

const providerContentFilterError = new OpenAI.BadRequestError(
  400,
  {
    code: 'content_filter',
    message: 'The provider blocked this prompt.',
    type: 'content_filter',
  },
  'content filter',
  new Headers(),
);

describe('isResponseFormatUnsupportedError', () => {
  it('should match DeepSeek json_schema rejection variants', () => {
    expect(
      isResponseFormatUnsupportedError(new Error('This response_format type is unavailable now')),
    ).toBe(true);
    expect(
      isResponseFormatUnsupportedError({
        error: {
          message:
            'Failed to deserialize the JSON body into the target type: response_format: response_format.type `json_schema` is unavailable now at line 1 column 1193',
        },
      }),
    ).toBe(true);
  });

  it('should not match unrelated errors', () => {
    expect(isResponseFormatUnsupportedError(new Error('Insufficient Balance'))).toBe(false);
    expect(isResponseFormatUnsupportedError(undefined)).toBe(false);
    expect(isResponseFormatUnsupportedError('response_format')).toBe(false);
  });
});

describe('generateObject tool-calling fallback', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const createInstance = () => new TestRuntime({ apiKey: 'test' });

  const getCreateMock = (instance: any) => instance.client.chat.completions.create as Mock;

  it('should proactively use tool calling for DeepSeek-family models', async () => {
    const instance = createInstance();
    vi.spyOn((instance as any).client.chat.completions, 'create').mockResolvedValue(
      toolCallResponse as any,
    );

    const result = await instance.generateObject({
      ...generateObjectPayload,
      model: 'deepseek-v4-flash',
    });

    const createMock = getCreateMock(instance);
    expect(createMock).toHaveBeenCalledTimes(1);

    const requestPayload = createMock.mock.calls[0][0];
    expect(requestPayload.response_format).toBeUndefined();
    expect(requestPayload.tool_choice).toEqual({
      function: { name: 'task_topic_handoff' },
      type: 'function',
    });
    expect(result).toEqual({ summary: 'Task completed', title: 'Done' });
  });

  it('should retry via tool calling when the provider rejects json_schema', async () => {
    const instance = createInstance();
    vi.spyOn((instance as any).client.chat.completions, 'create')
      .mockRejectedValueOnce(responseFormatUnsupportedError)
      .mockResolvedValueOnce(toolCallResponse as any);

    // model id gives no hint that the upstream is DeepSeek (e.g. gateway alias)
    const result = await instance.generateObject({ ...generateObjectPayload, model: 'big-pickle' });

    const createMock = getCreateMock(instance);
    expect(createMock).toHaveBeenCalledTimes(2);

    const firstPayload = createMock.mock.calls[0][0];
    expect(firstPayload.response_format).toEqual(expect.objectContaining({ type: 'json_schema' }));

    const retryPayload = createMock.mock.calls[1][0];
    expect(retryPayload.response_format).toBeUndefined();
    expect(retryPayload.tool_choice).toEqual({
      function: { name: 'task_topic_handoff' },
      type: 'function',
    });
    expect(result).toEqual({ summary: 'Task completed', title: 'Done' });
  });

  it('should not retry on unrelated provider errors', async () => {
    const instance = createInstance();
    vi.spyOn((instance as any).client.chat.completions, 'create').mockRejectedValue(
      Object.assign(new Error('Insufficient Balance'), { status: 402 }),
    );

    await expect(
      instance.generateObject({ ...generateObjectPayload, model: 'big-pickle' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('Insufficient Balance') });

    expect(getCreateMock(instance)).toHaveBeenCalledTimes(1);
  });

  it('should classify content_filter error codes as provider content policy violations', async () => {
    const instance = createInstance();
    vi.spyOn((instance as any).client.chat.completions, 'create').mockRejectedValue(
      providerContentFilterError,
    );

    await expect(
      instance.generateObject({
        ...generateObjectPayload,
        model: 'gpt-4o',
        responseApi: false,
      }),
    ).rejects.toMatchObject({
      error: {
        code: 'content_filter',
        type: 'content_filter',
      },
      errorType: AgentRuntimeErrorType.ProviderContentPolicyViolation,
    });

    expect(getCreateMock(instance)).toHaveBeenCalledTimes(1);
  });

  it('should classify nested content_filter payloads as provider content policy violations', async () => {
    const instance = createInstance();
    vi.spyOn((instance as any).client.chat.completions, 'create').mockRejectedValue(
      new OpenAI.APIError(
        400,
        {
          error: {
            code: 'content_filter',
            message: 'The provider blocked this prompt.',
            type: 'content_filter',
          },
          status: 400,
        },
        'content filter',
        new Headers(),
      ),
    );

    await expect(
      instance.generateObject({
        ...generateObjectPayload,
        model: 'gpt-4o',
        responseApi: false,
      }),
    ).rejects.toMatchObject({
      error: {
        error: expect.objectContaining({
          code: 'content_filter',
          type: 'content_filter',
        }),
      },
      errorType: AgentRuntimeErrorType.ProviderContentPolicyViolation,
    });

    expect(getCreateMock(instance)).toHaveBeenCalledTimes(1);
  });

  it('should classify content policy finish reasons as provider content policy violations', async () => {
    const instance = createInstance();
    vi.spyOn((instance as any).client.chat.completions, 'create').mockRejectedValue(
      new OpenAI.APIError(
        400,
        {
          choices: [{ finish_reason: 'content_policy_violation' }],
          message: 'The provider blocked this prompt.',
          status: 400,
        },
        'content filter',
        new Headers(),
      ),
    );

    await expect(
      instance.generateObject({
        ...generateObjectPayload,
        model: 'gpt-4o',
        responseApi: false,
      }),
    ).rejects.toMatchObject({
      error: {
        choices: [expect.objectContaining({ finish_reason: 'content_policy_violation' })],
      },
      errorType: AgentRuntimeErrorType.ProviderContentPolicyViolation,
    });

    expect(getCreateMock(instance)).toHaveBeenCalledTimes(1);
  });
});

/**
 * `chatCompletion.handleError` is a CHAT contract. Providers such as 302.AI and
 * SiliconCloud map every error through it, so `generateObject` must keep rethrowing the
 * raw error for them — only a provider that explicitly opts in gets its own payload here.
 */
describe('generateObject custom error mapping', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const upstreamFailure = Object.assign(new Error('Insufficient Balance'), { status: 402 });

  const handleEveryError = vi.fn(() => ({
    error: { message: 'mapped by the provider' },
    errorType: AgentRuntimeErrorType.ProviderBizError,
    message: 'mapped by the provider',
  }));

  const MapsEveryErrorRuntime = createOpenAICompatibleRuntime({
    baseURL: 'https://api.mapseverything.com/v1',
    chatCompletion: { handleError: handleEveryError },
    provider: 'mapseverything',
  });

  const OptedInRuntime = createOpenAICompatibleRuntime({
    baseURL: 'https://api.optedin.com/v1',
    chatCompletion: { handleError: handleEveryError },
    generateObject: { preserveCustomMappedErrors: true },
    provider: 'optedin',
  });

  it('rethrows the raw error for a provider that did not opt in (unchanged behaviour)', async () => {
    const instance = new MapsEveryErrorRuntime({ apiKey: 'test' });
    vi.spyOn((instance as any).client.chat.completions, 'create').mockRejectedValue(
      upstreamFailure,
    );

    await expect(instance.generateObject(generateObjectPayload)).rejects.toBe(upstreamFailure);
    // Mapped once per failure, never twice: the handler is a mapper, not guaranteed pure.
    expect(handleEveryError).toHaveBeenCalledTimes(1);
  });

  it('keeps the provider payload for a provider that opted in', async () => {
    const instance = new OptedInRuntime({ apiKey: 'test' });
    vi.spyOn((instance as any).client.chat.completions, 'create').mockRejectedValue(
      upstreamFailure,
    );

    await expect(instance.generateObject(generateObjectPayload)).rejects.toMatchObject({
      errorType: AgentRuntimeErrorType.ProviderBizError,
      message: 'mapped by the provider',
      provider: 'optedin',
    });
    expect(handleEveryError).toHaveBeenCalledTimes(1);
  });
});
