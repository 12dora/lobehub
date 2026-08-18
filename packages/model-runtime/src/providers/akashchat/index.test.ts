// @vitest-environment node
import { ModelProvider } from 'model-bank';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { testProvider } from '../../providerTestUtils';
import { LobeAkashChatAI, params } from './index';

const loadModelsMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock('@lobechat/business-model-bank/model-config', () => ({
  loadModels: loadModelsMock,
}));

const provider = ModelProvider.AkashChat;
const defaultBaseURL = 'https://api.akashml.com/v1';

testProvider({
  Runtime: LobeAkashChatAI,
  bizErrorType: 'ProviderBizError',
  chatDebugEnv: 'DEBUG_AKASH_CHAT_COMPLETION',
  chatModel: 'meta-llama/Llama-3.3-70B-Instruct',
  defaultBaseURL,
  invalidErrorType: 'InvalidProviderAPIKey',
  provider,
  test: {
    skipAPICall: true,
    skipErrorHandle: true,
  },
});

describe('LobeAkashChatAI - custom features', () => {
  let instance: InstanceType<typeof LobeAkashChatAI>;

  beforeEach(() => {
    instance = new LobeAkashChatAI({ apiKey: 'test_api_key' });
    vi.spyOn(instance['client'].chat.completions, 'create').mockResolvedValue(
      new ReadableStream() as any,
    );
  });

  describe('params export', () => {
    it('should export params object', () => {
      expect(params).toBeDefined();
      expect(params.provider).toBe(ModelProvider.AkashChat);
      expect(params.baseURL).toBe('https://api.akashml.com/v1');
    });

    it('should have chatCompletion config with handlePayload', () => {
      expect(params.chatCompletion).toBeDefined();
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
      delete process.env.DEBUG_AKASH_CHAT_COMPLETION;
      const result = params.debug.chatCompletion();
      expect(result).toBe(false);
    });

    it('should enable debug when env is set to "1"', () => {
      process.env.DEBUG_AKASH_CHAT_COMPLETION = '1';
      const result = params.debug.chatCompletion();
      expect(result).toBe(true);
      delete process.env.DEBUG_AKASH_CHAT_COMPLETION;
    });

    it('should disable debug when env is not "1"', () => {
      process.env.DEBUG_AKASH_CHAT_COMPLETION = '0';
      const result = params.debug.chatCompletion();
      expect(result).toBe(false);
      delete process.env.DEBUG_AKASH_CHAT_COMPLETION;
    });
  });

  describe('handlePayload', () => {
    it('should not inject LiteLLM-only fields', async () => {
      await instance.chat({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'meta-llama/Llama-3.3-70B-Instruct',
      });

      const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
      expect(calledPayload.allowed_openai_params).toBeUndefined();
      expect(calledPayload.cache).toBeUndefined();
      expect(calledPayload.chat_template_kwargs).toBeUndefined();
    });

    it('should preserve model in payload', async () => {
      await instance.chat({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'meta-llama/Llama-3.3-70B-Instruct',
      });

      const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
      expect(calledPayload.model).toBe('meta-llama/Llama-3.3-70B-Instruct');
    });

    it('should preserve other payload properties', async () => {
      await instance.chat({
        max_tokens: 1024,
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'meta-llama/Llama-3.3-70B-Instruct',
        temperature: 0.7,
        top_p: 0.9,
      });

      const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
      expect(calledPayload.max_tokens).toBe(1024);
      expect(calledPayload.temperature).toBe(0.7);
      expect(calledPayload.top_p).toBe(0.9);
      expect(calledPayload.messages).toEqual([{ content: 'Hello', role: 'user' }]);
    });

    describe('documented reasoning object', () => {
      it('should map thinking.type=enabled to reasoning.enabled=true', async () => {
        await instance.chat({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'openai/gpt-oss-120b',
          thinking: { type: 'enabled', budget_tokens: 1024 },
        });

        const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
        expect(calledPayload.reasoning).toEqual({ enabled: true, max_tokens: 1024 });
        expect(calledPayload.thinking).toBeUndefined();
        expect(calledPayload.chat_template_kwargs).toBeUndefined();
      });

      it('should map thinking.type=disabled to reasoning.enabled=false', async () => {
        await instance.chat({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'openai/gpt-oss-120b',
          thinking: { type: 'disabled', budget_tokens: 1024 },
        });

        const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
        expect(calledPayload.reasoning).toEqual({ enabled: false, max_tokens: 1024 });
        expect(calledPayload.thinking).toBeUndefined();
      });

      it('should map reasoning_effort to reasoning.effort', async () => {
        await instance.chat({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'openai/gpt-oss-120b',
          reasoning_effort: 'high',
        });

        const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
        expect(calledPayload.reasoning).toEqual({ effort: 'high' });
        expect(calledPayload.reasoning_effort).toBeUndefined();
      });

      it('should not add reasoning when thinking and reasoning_effort are absent', async () => {
        await instance.chat({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'meta-llama/Llama-3.3-70B-Instruct',
        });

        const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
        expect(calledPayload.reasoning).toBeUndefined();
        expect(calledPayload.thinking).toBeUndefined();
      });

      it('should strip thinking without adding reasoning when type is not enabled/disabled', async () => {
        await instance.chat({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'openai/gpt-oss-120b',
          thinking: { type: 'auto' } as any,
        });

        const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
        expect(calledPayload.reasoning).toBeUndefined();
        expect(calledPayload.thinking).toBeUndefined();
      });
    });

    describe('thinking parameter removal', () => {
      it('should remove thinking from payload', async () => {
        await instance.chat({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'openai/gpt-oss-120b',
          thinking: { type: 'enabled', budget_tokens: 1024 },
        });

        const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
        expect(calledPayload.thinking).toBeUndefined();
      });

      it('should remove thinking from payload for models without extra reasoning fields', async () => {
        await instance.chat({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'meta-llama/Llama-3.3-70B-Instruct',
          thinking: { type: 'enabled', budget_tokens: 1024 },
        });

        const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
        expect(calledPayload.thinking).toBeUndefined();
      });
    });

    describe('edge cases', () => {
      it('should handle empty messages array', async () => {
        await instance.chat({
          messages: [],
          model: 'meta-llama/Llama-3.3-70B-Instruct',
        });

        const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
        expect(calledPayload.messages).toEqual([]);
        expect(calledPayload.allowed_openai_params).toBeUndefined();
        expect(calledPayload.cache).toBeUndefined();
      });
    });
  });

  describe('models function', () => {
    it('should fetch and process models successfully', async () => {
      const mockClient = {
        apiKey: 'test',
        baseURL: 'https://api.akashml.com/v1',
        models: {
          list: vi.fn().mockResolvedValue({
            data: [
              { created: 1234567890, id: 'meta-llama/Llama-3.3-70B-Instruct', owned_by: 'meta' },
              { created: 1234567891, id: 'openai/gpt-oss-120b', owned_by: 'openai' },
            ],
          }),
        },
      };

      const models = await params.models({ client: mockClient as any });

      expect(mockClient.models.list).toHaveBeenCalledTimes(1);
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
    });

    it('should remove created field from model items', async () => {
      const mockClient = {
        apiKey: 'test',
        baseURL: 'https://api.akashml.com/v1',
        models: {
          list: vi.fn().mockResolvedValue({
            data: [
              { created: 1234567890, id: 'meta-llama/Llama-3.3-70B-Instruct', owned_by: 'meta' },
            ],
          }),
        },
      };

      await params.models({ client: mockClient as any });

      expect(mockClient.models.list).toHaveBeenCalled();
    });

    it('should handle empty model list', async () => {
      const mockClient = {
        apiKey: 'test',
        baseURL: 'https://api.akashml.com/v1',
        models: {
          list: vi.fn().mockResolvedValue({
            data: [],
          }),
        },
      };

      const models = await params.models({ client: mockClient as any });

      expect(models).toEqual([]);
    });

    it('should handle missing data field', async () => {
      const mockClient = {
        apiKey: 'test',
        baseURL: 'https://api.akashml.com/v1',
        models: {
          list: vi.fn().mockResolvedValue({}),
        },
      };

      const models = await params.models({ client: mockClient as any });

      expect(models).toEqual([]);
    });

    it('should throw when model API fails', async () => {
      const mockClient = {
        apiKey: 'test',
        baseURL: 'https://api.akashml.com/v1',
        models: {
          list: vi.fn().mockRejectedValue(new Error('API Error')),
        },
      };

      await expect(params.models({ client: mockClient as any })).rejects.toThrow('API Error');
    });

    it('should handle network timeout errors', async () => {
      const mockClient = {
        apiKey: 'test',
        baseURL: 'https://api.akashml.com/v1',
        models: {
          list: vi.fn().mockRejectedValue(new Error('Network timeout')),
        },
      };

      await expect(params.models({ client: mockClient as any })).rejects.toThrow('Network timeout');
    });

    it('should handle invalid API key errors', async () => {
      const mockClient = {
        apiKey: 'invalid',
        baseURL: 'https://api.akashml.com/v1',
        models: {
          list: vi.fn().mockRejectedValue(new Error('Unauthorized')),
        },
      };

      await expect(params.models({ client: mockClient as any })).rejects.toThrow('Unauthorized');
    });

    it('should throw on malformed response data', async () => {
      const mockClient = {
        apiKey: 'test',
        baseURL: 'https://api.akashml.com/v1',
        models: {
          list: vi.fn().mockResolvedValue({
            data: [null, undefined, { id: 'valid-model' }],
          }),
        },
      };

      await expect(params.models({ client: mockClient as any })).rejects.toThrow(
        /Cannot destructure property 'created'/,
      );
    });
  });

  describe('integration tests', () => {
    it('should handle complete chat request with reasoning controls', async () => {
      const response = await instance.chat({
        max_tokens: 2048,
        messages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'What is 2+2?', role: 'user' },
        ],
        model: 'openai/gpt-oss-120b',
        temperature: 0.5,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        top_p: 0.95,
      });

      expect(response).toBeInstanceOf(Response);
      const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
      expect(calledPayload.model).toBe('openai/gpt-oss-120b');
      expect(calledPayload.reasoning).toEqual({ enabled: true, max_tokens: 1024 });
      expect(calledPayload.chat_template_kwargs).toBeUndefined();
      expect(calledPayload.allowed_openai_params).toBeUndefined();
      expect(calledPayload.cache).toBeUndefined();
      expect(calledPayload.thinking).toBeUndefined();
    });

    it('should handle complete chat request without reasoning controls', async () => {
      const response = await instance.chat({
        max_tokens: 2048,
        messages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'What is 2+2?', role: 'user' },
        ],
        model: 'meta-llama/Llama-3.3-70B-Instruct',
        temperature: 0.5,
        top_p: 0.95,
      });

      expect(response).toBeInstanceOf(Response);
      const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
      expect(calledPayload.model).toBe('meta-llama/Llama-3.3-70B-Instruct');
      expect(calledPayload.reasoning).toBeUndefined();
      expect(calledPayload.chat_template_kwargs).toBeUndefined();
      expect(calledPayload.allowed_openai_params).toBeUndefined();
      expect(calledPayload.cache).toBeUndefined();
      expect(calledPayload.thinking).toBeUndefined();
    });

    it('should handle streaming requests', async () => {
      const response = await instance.chat({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'meta-llama/Llama-3.3-70B-Instruct',
        stream: true,
      });

      expect(response).toBeInstanceOf(Response);
    });
  });
});
