// @vitest-environment node
import type { PricingUnit } from 'model-bank';
import { ModelProvider } from 'model-bank';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testProvider } from '../../providerTestUtils';
import { LobeCerebrasAI, params } from './index';

const loadModelsMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock('@lobechat/business-model-bank/model-config', () => ({
  loadModels: loadModelsMock,
}));

testProvider({
  Runtime: LobeCerebrasAI,
  bizErrorType: 'ProviderBizError',
  chatDebugEnv: 'DEBUG_CEREBRAS_CHAT_COMPLETION',
  chatModel: 'llama3.1-8b',
  defaultBaseURL: 'https://api.cerebras.ai/v1',
  invalidErrorType: 'InvalidProviderAPIKey',
  provider: ModelProvider.Cerebras,
  test: {
    skipAPICall: true,
    skipErrorHandle: true,
  },
});

/** `rate` lives on the fixed-strategy member only; narrowing keeps the assertion honest. */
const fixedRate = (units: PricingUnit[] | undefined, name: string): number | undefined => {
  const unit = units?.find((item) => item.name === name);
  return unit && unit.strategy === 'fixed' ? unit.rate : undefined;
};

describe('LobeCerebrasAI - custom features', () => {
  let instance: InstanceType<typeof LobeCerebrasAI>;

  beforeEach(() => {
    instance = new LobeCerebrasAI({ apiKey: 'test_api_key' });
    vi.spyOn(instance['client'].chat.completions, 'create').mockResolvedValue(
      new ReadableStream() as any,
    );
  });

  describe('params configuration', () => {
    it('should export params object with correct baseURL', () => {
      expect(params.baseURL).toBe('https://api.cerebras.ai/v1');
    });

    it('should export params with correct provider', () => {
      expect(params.provider).toBe(ModelProvider.Cerebras);
    });

    it('should have chatCompletion handlePayload function', () => {
      expect(params.chatCompletion?.handlePayload).toBeDefined();
      expect(typeof params.chatCompletion?.handlePayload).toBe('function');
    });

    it('should have debug configuration', () => {
      expect(params.debug).toBeDefined();
      expect(params.debug.chatCompletion).toBeDefined();
      expect(typeof params.debug.chatCompletion).toBe('function');
    });

    it('should have models function', () => {
      expect(params.models).toBeDefined();
      expect(typeof params.models).toBe('function');
    });
  });

  describe('debug configuration', () => {
    it('should disable debug by default', () => {
      delete process.env.DEBUG_CEREBRAS_CHAT_COMPLETION;
      const result = params.debug.chatCompletion();
      expect(result).toBe(false);
    });

    it('should enable debug when env is set to 1', () => {
      process.env.DEBUG_CEREBRAS_CHAT_COMPLETION = '1';
      const result = params.debug.chatCompletion();
      expect(result).toBe(true);
    });

    it('should disable debug when env is set to 0', () => {
      process.env.DEBUG_CEREBRAS_CHAT_COMPLETION = '0';
      const result = params.debug.chatCompletion();
      expect(result).toBe(false);
    });

    it('should disable debug when env is empty string', () => {
      process.env.DEBUG_CEREBRAS_CHAT_COMPLETION = '';
      const result = params.debug.chatCompletion();
      expect(result).toBe(false);
    });
  });

  describe('handlePayload', () => {
    it('should remove frequency_penalty and presence_penalty from payload', async () => {
      await instance.chat({
        frequency_penalty: 0.5,
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'llama3.1-8b',
        presence_penalty: 0.5,
      });

      const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
      expect(calledPayload.frequency_penalty).toBeUndefined();
      expect(calledPayload.presence_penalty).toBeUndefined();
      expect(calledPayload.model).toBe('llama3.1-8b');
    });

    it('should preserve model in the payload', async () => {
      await instance.chat({
        frequency_penalty: 0.5,
        messages: [{ content: 'Test', role: 'user' }],
        model: 'llama3.1-70b',
        presence_penalty: 0.5,
      });

      const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
      expect(calledPayload.model).toBe('llama3.1-70b');
    });

    it('should preserve other payload properties', async () => {
      await instance.chat({
        frequency_penalty: 0.5,
        max_tokens: 1000,
        messages: [{ content: 'Test', role: 'user' }],
        model: 'llama3.1-8b',
        presence_penalty: 0.5,
        stream: true,
        temperature: 0.8,
        top_p: 0.9,
      });

      const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
      expect(calledPayload.temperature).toBe(0.8);
      expect(calledPayload.max_tokens).toBe(1000);
      expect(calledPayload.top_p).toBe(0.9);
      expect(calledPayload.stream).toBe(true);
      expect(calledPayload.frequency_penalty).toBeUndefined();
      expect(calledPayload.presence_penalty).toBeUndefined();
    });

    it('should handle payload without frequency_penalty and presence_penalty', async () => {
      await instance.chat({
        messages: [{ content: 'Test', role: 'user' }],
        model: 'llama3.1-8b',
        temperature: 0.7,
      });

      const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
      expect(calledPayload.model).toBe('llama3.1-8b');
      expect(calledPayload.temperature).toBe(0.7);
      expect(calledPayload.frequency_penalty).toBeUndefined();
      expect(calledPayload.presence_penalty).toBeUndefined();
    });

    it('should handle payload with only frequency_penalty', async () => {
      await instance.chat({
        frequency_penalty: 0.5,
        messages: [{ content: 'Test', role: 'user' }],
        model: 'llama3.1-8b',
      });

      const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
      expect(calledPayload.frequency_penalty).toBeUndefined();
      expect(calledPayload.presence_penalty).toBeUndefined();
    });

    it('should handle payload with only presence_penalty', async () => {
      await instance.chat({
        messages: [{ content: 'Test', role: 'user' }],
        model: 'llama3.1-8b',
        presence_penalty: 0.5,
      });

      const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
      expect(calledPayload.frequency_penalty).toBeUndefined();
      expect(calledPayload.presence_penalty).toBeUndefined();
    });

    it('should handle payload with zero values for penalties', async () => {
      await instance.chat({
        frequency_penalty: 0,
        messages: [{ content: 'Test', role: 'user' }],
        model: 'llama3.1-8b',
        presence_penalty: 0,
      });

      const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
      expect(calledPayload.frequency_penalty).toBeUndefined();
      expect(calledPayload.presence_penalty).toBeUndefined();
    });

    it('should call handlePayload directly and verify transformation', () => {
      const payload = {
        frequency_penalty: 0.5,
        max_tokens: 100,
        messages: [{ content: 'Test', role: 'user' }],
        model: 'llama3.1-8b',
        presence_penalty: 0.5,
        temperature: 0.7,
      };

      const transformedPayload = params.chatCompletion!.handlePayload!(payload as any);

      expect(transformedPayload.model).toBe('llama3.1-8b');
      expect(transformedPayload.temperature).toBe(0.7);
      expect(transformedPayload.max_tokens).toBe(100);
      expect(transformedPayload.frequency_penalty).toBeUndefined();
      expect(transformedPayload.presence_penalty).toBeUndefined();
    });
  });

  describe('models function', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      // Public catalog is enrichment-only; default to a failed public request
      // so existing list-shape tests stay on the /v1/models source of truth.
      global.fetch = vi.fn().mockRejectedValue(new Error('public catalog unavailable'));
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should fetch and process models with data property', async () => {
      const mockClient = {
        apiKey: 'test_api_key',
        baseURL: 'https://api.cerebras.ai/v1',
        models: {
          list: vi.fn().mockResolvedValue({
            data: [
              { id: 'llama3.1-8b', object: 'model', owned_by: 'cerebras' },
              { id: 'llama3.1-70b', object: 'model', owned_by: 'cerebras' },
            ],
          }),
        },
      } as any;

      const models = await params.models!({ client: mockClient });

      expect(mockClient.models.list).toHaveBeenCalledTimes(1);
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
    });

    it('should handle models list without data property (direct array)', async () => {
      const mockClient = {
        apiKey: 'test_api_key',
        baseURL: 'https://api.cerebras.ai/v1',
        models: {
          list: vi.fn().mockResolvedValue([
            { id: 'llama3.1-8b', object: 'model', owned_by: 'cerebras' },
            { id: 'llama3.1-70b', object: 'model', owned_by: 'cerebras' },
          ]),
        },
      } as any;

      const models = await params.models!({ client: mockClient });

      expect(mockClient.models.list).toHaveBeenCalledTimes(1);
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
    });

    it('should handle empty models list with data property', async () => {
      const mockClient = {
        apiKey: 'test_api_key',
        baseURL: 'https://api.cerebras.ai/v1',
        models: {
          list: vi.fn().mockResolvedValue({
            data: [],
          }),
        },
      } as any;

      const models = await params.models!({ client: mockClient });

      expect(mockClient.models.list).toHaveBeenCalledTimes(1);
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models).toHaveLength(0);
    });

    it('should handle empty models list without data property', async () => {
      const mockClient = {
        apiKey: 'test_api_key',
        baseURL: 'https://api.cerebras.ai/v1',
        models: {
          list: vi.fn().mockResolvedValue([]),
        },
      } as any;

      const models = await params.models!({ client: mockClient });

      expect(mockClient.models.list).toHaveBeenCalledTimes(1);
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models).toHaveLength(0);
    });

    it('should handle null response', async () => {
      const mockClient = {
        apiKey: 'test_api_key',
        baseURL: 'https://api.cerebras.ai/v1',
        models: {
          list: vi.fn().mockResolvedValue(null),
        },
      } as any;

      const models = await params.models!({ client: mockClient });

      expect(mockClient.models.list).toHaveBeenCalledTimes(1);
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models).toHaveLength(0);
    });

    it('should handle undefined response', async () => {
      const mockClient = {
        apiKey: 'test_api_key',
        baseURL: 'https://api.cerebras.ai/v1',
        models: {
          list: vi.fn().mockResolvedValue(undefined),
        },
      } as any;

      const models = await params.models!({ client: mockClient });

      expect(mockClient.models.list).toHaveBeenCalledTimes(1);
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models).toHaveLength(0);
    });

    it('should handle response with non-array data', async () => {
      const mockClient = {
        apiKey: 'test_api_key',
        baseURL: 'https://api.cerebras.ai/v1',
        models: {
          list: vi.fn().mockResolvedValue({
            data: 'not-an-array',
          }),
        },
      } as any;

      const models = await params.models!({ client: mockClient });

      expect(mockClient.models.list).toHaveBeenCalledTimes(1);
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models).toHaveLength(0);
    });

    it('should throw when network error occurs', async () => {
      const mockClient = {
        apiKey: 'test_api_key',
        baseURL: 'https://api.cerebras.ai/v1',
        models: {
          list: vi.fn().mockRejectedValue(new Error('Network error')),
        },
      } as any;

      await expect(params.models!({ client: mockClient })).rejects.toThrow('Network error');

      expect(mockClient.models.list).toHaveBeenCalledTimes(1);
    });

    it('should throw when API authentication fails', async () => {
      const mockClient = {
        apiKey: 'invalid_key',
        baseURL: 'https://api.cerebras.ai/v1',
        models: {
          list: vi.fn().mockRejectedValue(new Error('401 Unauthorized')),
        },
      } as any;

      await expect(params.models!({ client: mockClient })).rejects.toThrow('401 Unauthorized');

      expect(mockClient.models.list).toHaveBeenCalledTimes(1);
    });

    it('should throw when API rate limit fails', async () => {
      const mockClient = {
        apiKey: 'test_api_key',
        baseURL: 'https://api.cerebras.ai/v1',
        models: {
          list: vi.fn().mockRejectedValue(new Error('429 Too Many Requests')),
        },
      } as any;

      await expect(params.models!({ client: mockClient })).rejects.toThrow('429 Too Many Requests');

      expect(mockClient.models.list).toHaveBeenCalledTimes(1);
    });

    it('should throw when request times out', async () => {
      const mockClient = {
        apiKey: 'test_api_key',
        baseURL: 'https://api.cerebras.ai/v1',
        models: {
          list: vi.fn().mockRejectedValue(new Error('Request timeout')),
        },
      } as any;

      await expect(params.models!({ client: mockClient })).rejects.toThrow('Request timeout');

      expect(mockClient.models.list).toHaveBeenCalledTimes(1);
    });

    it('should handle malformed JSON response', async () => {
      const mockClient = {
        apiKey: 'test_api_key',
        baseURL: 'https://api.cerebras.ai/v1',
        models: {
          list: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
        },
      } as any;

      await expect(params.models!({ client: mockClient })).rejects.toThrow('Invalid JSON');

      expect(mockClient.models.list).toHaveBeenCalledTimes(1);
    });

    it('should pass correct client to processMultiProviderModelList', async () => {
      const mockModelList = [
        { id: 'llama3.1-8b', object: 'model', owned_by: 'cerebras' },
        { id: 'llama3.1-70b', object: 'model', owned_by: 'cerebras' },
      ];

      const mockClient = {
        apiKey: 'test_api_key',
        baseURL: 'https://api.cerebras.ai/v1',
        models: {
          list: vi.fn().mockResolvedValue({ data: mockModelList }),
        },
      } as any;

      const models = await params.models!({ client: mockClient });

      // Verify processMultiProviderModelList was called with correct parameters
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
    });

    it('should enrich /v1/models from the public catalog, joined on id', async () => {
      // Default Cerebras format from R3 §2.2 — USD per token as decimal strings.
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => ({
          data: [
            {
              capabilities: {
                function_calling: true,
                reasoning: false,
                vision: false,
              },
              description: 'Gemma 4 31B',
              id: 'gemma-4-31b',
              limits: {
                max_completion_tokens: 8192,
                max_context_length: 131_072,
              },
              name: 'Gemma 4 31B',
              pricing: {
                completion: '0.00000149',
                prompt: '0.00000099',
              },
            },
          ],
          object: 'list',
        }),
        ok: true,
        status: 200,
      });

      const mockClient = {
        apiKey: 'test_api_key',
        baseURL: 'https://api.cerebras.ai/v1',
        models: {
          list: vi.fn().mockResolvedValue({
            data: [
              { created: 0, id: 'gemma-4-31b', object: 'model', owned_by: 'cerebras' },
              { created: 0, id: 'gpt-oss-120b', object: 'model', owned_by: 'cerebras' },
            ],
          }),
        },
      } as any;

      const models = await params.models!({ client: mockClient });

      expect(global.fetch).toHaveBeenCalledWith('https://api.cerebras.ai/public/v1/models');
      expect(models.map((m) => m.id)).toEqual(['gemma-4-31b', 'gpt-oss-120b']);

      const gemma = models.find((m) => m.id === 'gemma-4-31b');
      expect(gemma).toMatchObject({
        contextWindowTokens: 131_072,
        description: 'Gemma 4 31B',
        displayName: 'Gemma 4 31B',
        functionCall: true,
        id: 'gemma-4-31b',
        maxOutput: 8192,
        reasoning: false,
        vision: false,
      });
      const input = fixedRate(gemma?.pricing?.units, 'textInput');
      const output = fixedRate(gemma?.pricing?.units, 'textOutput');
      expect(input).toBeCloseTo(0.99);
      expect(output).toBeCloseTo(1.49);

      // Public list is a subset — missing ids come back with no metadata.
      const oss = models.find((m) => m.id === 'gpt-oss-120b');
      expect(oss?.id).toBe('gpt-oss-120b');
      expect(oss?.contextWindowTokens).toBeUndefined();
      expect(oss?.pricing).toBeUndefined();
    });

    it('should keep the authenticated list when the public catalog fails', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('public catalog down'));

      const mockClient = {
        apiKey: 'test_api_key',
        baseURL: 'https://api.cerebras.ai/v1',
        models: {
          list: vi.fn().mockResolvedValue({
            data: [{ id: 'llama3.1-8b', object: 'model', owned_by: 'cerebras' }],
          }),
        },
      } as any;

      const models = await params.models!({ client: mockClient });

      expect(models).toHaveLength(1);
      expect(models[0]?.id).toBe('llama3.1-8b');
    });
  });
});
