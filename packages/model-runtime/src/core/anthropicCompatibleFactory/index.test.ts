// @vitest-environment node
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAnthropicCompatibleRuntime,
  createDefaultAnthropicClient,
  createDefaultAnthropicModels,
  DEFAULT_ANTHROPIC_TIMEOUT,
} from './index';

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn();
  return { default: MockAnthropic };
});

vi.mock('@lobechat/const', () => ({
  CURRENT_VERSION: '1.0.0-test',
}));

vi.mock('@lobechat/business-model-bank/model-config', () => ({
  loadModels: vi.fn().mockResolvedValue([]),
}));

const MockedAnthropic = vi.mocked(Anthropic);
const originalAnthropicClientTimeout = process.env.ANTHROPIC_CLIENT_TIMEOUT;

afterEach(() => {
  if (originalAnthropicClientTimeout === undefined) {
    delete process.env.ANTHROPIC_CLIENT_TIMEOUT;
  } else {
    process.env.ANTHROPIC_CLIENT_TIMEOUT = originalAnthropicClientTimeout;
  }
});

describe('createDefaultAnthropicClient', () => {
  it('should include User-Agent header with current version', () => {
    MockedAnthropic.mockClear();

    createDefaultAnthropicClient({ apiKey: 'test-key' });

    expect(MockedAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultHeaders: expect.objectContaining({
          'User-Agent': 'lobehub/1.0.0-test',
        }),
      }),
    );
  });

  it('should preserve caller-provided default headers alongside User-Agent', () => {
    MockedAnthropic.mockClear();

    createDefaultAnthropicClient({
      apiKey: 'test-key',
      defaultHeaders: { 'X-Custom': 'value' },
    });

    const passedOptions = MockedAnthropic.mock.calls[0][0] as any;

    expect(passedOptions.defaultHeaders).toMatchObject({
      'User-Agent': 'lobehub/1.0.0-test',
      'X-Custom': 'value',
    });
  });

  it('should set the default Anthropic timeout explicitly', () => {
    MockedAnthropic.mockClear();
    delete process.env.ANTHROPIC_CLIENT_TIMEOUT;

    createDefaultAnthropicClient({ apiKey: 'test-key' });

    expect(MockedAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: DEFAULT_ANTHROPIC_TIMEOUT,
      }),
    );
  });

  it('should use ANTHROPIC_CLIENT_TIMEOUT as the default timeout when configured', () => {
    MockedAnthropic.mockClear();
    process.env.ANTHROPIC_CLIENT_TIMEOUT = '780000';

    createDefaultAnthropicClient({ apiKey: 'test-key' });

    expect(MockedAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: 780_000,
      }),
    );

    delete process.env.ANTHROPIC_CLIENT_TIMEOUT;
  });

  it('should ignore invalid ANTHROPIC_CLIENT_TIMEOUT values', () => {
    MockedAnthropic.mockClear();
    process.env.ANTHROPIC_CLIENT_TIMEOUT = 'invalid';

    createDefaultAnthropicClient({ apiKey: 'test-key' });

    expect(MockedAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: DEFAULT_ANTHROPIC_TIMEOUT,
      }),
    );

    delete process.env.ANTHROPIC_CLIENT_TIMEOUT;
  });

  it('should preserve caller-provided timeout', () => {
    MockedAnthropic.mockClear();
    process.env.ANTHROPIC_CLIENT_TIMEOUT = '780000';

    createDefaultAnthropicClient({
      apiKey: 'test-key',
      timeout: 3_600_000,
    });

    expect(MockedAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: 3_600_000,
      }),
    );

    delete process.env.ANTHROPIC_CLIENT_TIMEOUT;
  });

  it.each([
    ['https://aihubmix.com/v1', 'https://aihubmix.com'],
    ['https://aihubmix.com/v1/messages', 'https://aihubmix.com'],
    ['https://api.example.com/anthropic/v1', 'https://api.example.com/anthropic'],
    ['https://api.example.com/anthropic', 'https://api.example.com/anthropic'],
  ])('should normalize Anthropic SDK-managed baseURL path %s', (baseURL, expectedBaseURL) => {
    MockedAnthropic.mockClear();

    createDefaultAnthropicClient({ apiKey: 'test-key', baseURL });

    expect(MockedAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: expectedBaseURL,
      }),
    );
  });
});

describe('createAnthropicCompatibleRuntime', () => {
  it('should normalize default baseURL before creating a custom client', () => {
    const createClient = vi.fn((options) => ({ baseURL: options.baseURL }) as unknown as Anthropic);
    const Runtime = createAnthropicCompatibleRuntime({
      baseURL: 'https://aihubmix.com/v1',
      customClient: { createClient },
      provider: 'test-provider',
    });

    const runtime = new Runtime({ apiKey: 'test-key' });

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://aihubmix.com',
        timeout: DEFAULT_ANTHROPIC_TIMEOUT,
      }),
    );
    expect(runtime.baseURL).toBe('https://aihubmix.com');
  });

  it('should send mapped model id to Anthropic Messages API', async () => {
    const messagesCreate = vi.fn().mockResolvedValue({ content: [] });
    const getPricingOptions = vi.fn(() => undefined);
    const handlePayload = vi.fn((payload) => ({
      max_tokens: 1024,
      messages: [],
      model: payload.model,
    }));
    const createClient = vi.fn((options) => ({
      baseURL: options.baseURL,
      messages: { create: messagesCreate },
    }));
    const Runtime = createAnthropicCompatibleRuntime({
      chatCompletion: {
        getPricingOptions,
        handlePayload,
      },
      customClient: {
        createClient: (options) => createClient(options) as unknown as Anthropic,
      },
      provider: 'test-provider',
    });
    const runtime = new Runtime({
      apiKey: 'test-key',
      modelIdMapping: { 'logical-model': 'upstream-model' },
    });

    await runtime.chat({
      messages: [{ content: 'hi', role: 'user' }],
      model: 'logical-model',
      responseMode: 'json',
      stream: false,
    } as any);

    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'upstream-model',
      }),
      expect.anything(),
    );
    expect(handlePayload).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'logical-model' }),
      expect.anything(),
    );
    expect(getPricingOptions).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'logical-model' }),
      expect.objectContaining({ model: 'logical-model' }),
    );
    expect(createClient.mock.calls[0][0]).not.toHaveProperty('modelIdMapping');
  });

  it('should keep logical model for generateObject and pass mapped id as request config', async () => {
    const generateObject = vi.fn().mockResolvedValue({ ok: true });
    const Runtime = createAnthropicCompatibleRuntime({
      chatCompletion: {
        handlePayload: (payload) => ({
          max_tokens: 1024,
          messages: [],
          model: payload.model,
        }),
      },
      customClient: {
        createClient: () =>
          ({
            baseURL: 'https://aihubmix.com',
            messages: { create: vi.fn() },
          }) as unknown as Anthropic,
      },
      generateObject,
      provider: 'test-provider',
    });
    const runtime = new Runtime({
      apiKey: 'test-key',
      modelIdMapping: { 'logical-model': 'upstream-model' },
    });

    const result = await runtime.generateObject({
      messages: [{ content: 'hi', role: 'user' }],
      model: 'logical-model',
      schema: {
        name: 'result',
        schema: { properties: {}, type: 'object' },
      },
    });

    expect(generateObject).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: 'logical-model' }),
      undefined,
      undefined,
      expect.objectContaining({ requestModel: 'upstream-model' }),
    );
    expect(result).toEqual({ ok: true });
  });
});

const jsonResponse = (body: unknown) =>
  ({
    json: async () => body,
    ok: true,
  }) as Response;

describe('createDefaultAnthropicModels', () => {
  it('maps documented ModelInfo fields and keeps created_at on the generic releasedAt path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            capabilities: {
              code_execution: { supported: true },
              image_input: { supported: true },
              pdf_input: { supported: true },
              structured_outputs: { supported: true },
              thinking: { supported: true },
            },
            created_at: '2025-09-29T00:00:00Z',
            display_name: 'Claude Sonnet 4.5',
            id: 'claude-sonnet-4-5-20250929',
            max_input_tokens: 200_000,
            max_tokens: 64_000,
            type: 'model',
          },
        ],
        first_id: 'claude-sonnet-4-5-20250929',
        has_more: false,
        last_id: 'claude-sonnet-4-5-20250929',
      }),
    );

    const models = await createDefaultAnthropicModels({
      apiKey: 'test-key',
      baseURL: 'https://api.anthropic.com',
      fetch: fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models?limit=1000',
      expect.objectContaining({
        headers: {
          'anthropic-version': '2023-06-01',
          'x-api-key': 'test-key',
        },
        method: 'GET',
      }),
    );
    expect(models).toEqual([
      expect.objectContaining({
        contextWindowTokens: 200_000,
        displayName: 'Claude Sonnet 4.5',
        id: 'claude-sonnet-4-5-20250929',
        maxOutput: 64_000,
        reasoning: true,
        releasedAt: '2025-09-29',
        vision: true,
      }),
    ]);
    // code_execution is the server tool, not generic tool_use.
    expect(models[0]).not.toHaveProperty('code_execution');
  });

  it('forwards false capability flags so keyword fallbacks do not override them', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            capabilities: {
              image_input: { supported: false },
              thinking: { supported: false },
            },
            created_at: '2024-03-04T00:00:00Z',
            display_name: 'Text-only Claude',
            id: 'claude-text-only-custom',
          },
        ],
        has_more: false,
      }),
    );

    const models = await createDefaultAnthropicModels({
      apiKey: 'test-key',
      baseURL: 'https://api.anthropic.com',
      fetch: fetchImpl,
    });

    expect(models).toEqual([
      expect.objectContaining({
        id: 'claude-text-only-custom',
        reasoning: false,
        vision: false,
      }),
    ]);
  });

  it('leaves abilities undefined on the wire when capabilities is null so keywords can run', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            capabilities: null,
            created_at: '2024-03-04T00:00:00Z',
            display_name: 'Claude 3 Opus',
            id: 'claude-3-opus-20240229',
            max_input_tokens: null,
            max_tokens: null,
          },
        ],
        has_more: false,
      }),
    );

    const models = await createDefaultAnthropicModels({
      apiKey: 'test-key',
      baseURL: 'https://api.anthropic.com',
      fetch: fetchImpl,
    });

    expect(models).toEqual([
      expect.objectContaining({
        displayName: 'Claude 3 Opus',
        functionCall: true,
        id: 'claude-3-opus-20240229',
        vision: true,
      }),
    ]);
  });

  it('follows last_id when has_more is true', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ created_at: '2025-01-01T00:00:00Z', display_name: 'One', id: 'model-1' }],
          has_more: true,
          last_id: 'model-1',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ created_at: '2025-01-02T00:00:00Z', display_name: 'Two', id: 'model-2' }],
          has_more: false,
          last_id: 'model-2',
        }),
      );

    const models = await createDefaultAnthropicModels({
      apiKey: 'test-key',
      baseURL: 'https://api.anthropic.com',
      fetch: fetchImpl,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.anthropic.com/v1/models?limit=1000',
      expect.anything(),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.anthropic.com/v1/models?limit=1000&after_id=model-1',
      expect.anything(),
    );
    expect(models.map((model) => model.id)).toEqual(['model-1', 'model-2']);
  });

  it('throws when the API key is missing', async () => {
    await expect(
      createDefaultAnthropicModels({
        baseURL: 'https://api.anthropic.com',
        fetch: vi.fn(),
      }),
    ).rejects.toThrow('Missing Anthropic API key for model listing');
  });
});
