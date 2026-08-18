// @vitest-environment node
import { ModelProvider } from 'model-bank';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testProvider } from '../../providerTestUtils';
import { LobeLMStudioAI, params } from './index';

const provider = ModelProvider.LMStudio;
const defaultBaseURL = 'http://127.0.0.1:1234/v1';

testProvider({
  Runtime: LobeLMStudioAI,
  chatDebugEnv: 'DEBUG_LMSTUDIO_CHAT_COMPLETION',
  chatModel: 'deepseek-r1',
  defaultBaseURL,
  provider,
  test: {
    skipAPICall: true,
  },
});

describe('LobeLMStudioAI - custom features', () => {
  let instance: InstanceType<typeof LobeLMStudioAI>;

  beforeEach(() => {
    instance = new LobeLMStudioAI({ apiKey: 'placeholder-to-avoid-error' });
    vi.spyOn(instance['client'].chat.completions, 'create').mockResolvedValue(
      new ReadableStream() as any,
    );
  });

  describe('params export', () => {
    it('should export params with correct structure', () => {
      expect(params).toBeDefined();
      expect(params.provider).toBe(ModelProvider.LMStudio);
      expect(params.baseURL).toBe('http://127.0.0.1:1234/v1');
      expect(params.apiKey).toBe('placeholder-to-avoid-error');
      expect(params.debug).toBeDefined();
      expect(params.models).toBeDefined();
    });

    it('should have debug.chatCompletion function', () => {
      expect(typeof params.debug?.chatCompletion).toBe('function');
    });

    it('should return false when DEBUG_LMSTUDIO_CHAT_COMPLETION is not set', () => {
      delete process.env.DEBUG_LMSTUDIO_CHAT_COMPLETION;
      expect(params.debug?.chatCompletion()).toBe(false);
    });

    it('should return true when DEBUG_LMSTUDIO_CHAT_COMPLETION is set to 1', () => {
      process.env.DEBUG_LMSTUDIO_CHAT_COMPLETION = '1';
      expect(params.debug?.chatCompletion()).toBe(true);
      delete process.env.DEBUG_LMSTUDIO_CHAT_COMPLETION;
    });
  });

  describe('models function', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      vi.clearAllMocks();
      // Default: older LM Studio (< 0.4.0) 404s the native path.
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should fetch and process models successfully', async () => {
      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue({
            data: [{ id: 'deepseek-r1' }, { id: 'llama-3' }],
          }),
        },
      };

      const models = await params.models!({ client: mockClient as any });
      expect(models).toBeDefined();
      expect(mockClient.models.list).toHaveBeenCalled();
    });

    it('should handle known models from LOBE_DEFAULT_MODEL_LIST', async () => {
      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue({
            data: [{ id: 'gpt-4' }],
          }),
        },
      };

      const models = await params.models!({ client: mockClient as any });
      expect(models).toBeDefined();
    });

    it('should handle case-insensitive model matching', async () => {
      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue({
            data: [{ id: 'GPT-4' }, { id: 'Claude-3-Sonnet' }],
          }),
        },
      };

      const models = await params.models!({ client: mockClient as any });
      expect(models).toBeDefined();
    });

    it('should handle unknown models', async () => {
      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue({
            data: [{ id: 'unknown-model-123' }],
          }),
        },
      };

      const models = await params.models!({ client: mockClient as any });
      expect(models).toBeDefined();
    });

    it('should merge abilities from known models', async () => {
      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue({
            data: [{ id: 'gpt-4' }],
          }),
        },
      };

      const models = await params.models!({ client: mockClient as any });
      expect(models).toBeDefined();
    });

    it('should set enabled to false when not in known models', async () => {
      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue({
            data: [{ id: 'custom-local-model' }],
          }),
        },
      };

      const models = await params.models!({ client: mockClient as any });
      expect(models).toBeDefined();
    });

    it('should handle empty model list', async () => {
      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue({
            data: [],
          }),
        },
      };

      const models = await params.models!({ client: mockClient as any });
      expect(models).toEqual([]);
    });

    it('should handle models with abilities', async () => {
      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue({
            data: [{ id: 'deepseek-r1' }, { id: 'gpt-4-vision-preview' }, { id: 'claude-3-opus' }],
          }),
        },
      };

      const models = await params.models!({ client: mockClient as any });
      expect(models).toBeDefined();
    });

    it('should handle models without contextWindowTokens', async () => {
      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue({
            data: [{ id: 'new-model-without-metadata' }],
          }),
        },
      };

      const models = await params.models!({ client: mockClient as any });
      expect(models).toBeDefined();
    });

    it('should filter Boolean values correctly', async () => {
      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue({
            data: [{ id: 'model-1' }, { id: 'model-2' }],
          }),
        },
      };

      const models = await params.models!({ client: mockClient as any });
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
    });

    it('should fall back to OpenAI-compatible /v1/models on native 404', async () => {
      const mockClient = {
        apiKey: 'placeholder-to-avoid-error',
        baseURL: 'http://127.0.0.1:1234/v1',
        models: {
          list: vi.fn().mockResolvedValue({
            data: [{ id: 'legacy-local-model' }],
          }),
        },
      };

      const models = await params.models!({ client: mockClient as any });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:1234/api/v1/models',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(mockClient.models.list).toHaveBeenCalled();
      expect(models.map((m) => m.id)).toEqual(['legacy-local-model']);
    });

    it('should map documented native /api/v1/models fields', async () => {
      // Wire shape from https://lmstudio.ai/docs/developer/rest/list (R4 §4.2).
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => ({
          models: [
            {
              capabilities: {
                reasoning: { allowed_options: ['off', 'on'], default: 'off' },
                trained_for_tool_use: true,
                vision: true,
              },
              description: 'Local vision instruct checkpoint',
              display_name: 'Qwen2 VL 7B',
              key: 'qwen2-vl-7b-instruct',
              max_context_length: 32_768,
              type: 'llm',
            },
            {
              description: null,
              display_name: 'Nomic Embed',
              key: 'text-embedding-nomic-embed-text-v1.5',
              max_context_length: 2048,
              type: 'embedding',
            },
          ],
        }),
        ok: true,
        status: 200,
      });

      const mockClient = {
        apiKey: 'placeholder-to-avoid-error',
        baseURL: 'http://127.0.0.1:1234/v1',
        models: {
          list: vi.fn(),
        },
      };

      const models = await params.models!({ client: mockClient as any });

      expect(mockClient.models.list).not.toHaveBeenCalled();
      expect(models).toHaveLength(2);

      const chat = models.find((m) => m.id === 'qwen2-vl-7b-instruct');
      expect(chat).toMatchObject({
        contextWindowTokens: 32_768,
        description: 'Local vision instruct checkpoint',
        displayName: 'Qwen2 VL 7B',
        functionCall: true,
        id: 'qwen2-vl-7b-instruct',
        reasoning: true,
        type: 'chat',
        vision: true,
      });

      const embedding = models.find((m) => m.id === 'text-embedding-nomic-embed-text-v1.5');
      expect(embedding).toMatchObject({
        contextWindowTokens: 2048,
        displayName: 'Nomic Embed',
        id: 'text-embedding-nomic-embed-text-v1.5',
        type: 'embedding',
      });
    });

    it('should leave reasoning unset when allowed_options is only off', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => ({
          models: [
            {
              capabilities: {
                reasoning: { allowed_options: ['off'], default: 'off' },
                trained_for_tool_use: false,
                vision: false,
              },
              display_name: 'Plain Local Chat',
              key: 'plain-local-chat',
              max_context_length: 4096,
              type: 'llm',
            },
          ],
        }),
        ok: true,
        status: 200,
      });

      const models = await params.models!({
        client: { apiKey: 'placeholder-to-avoid-error', models: { list: vi.fn() } } as any,
      });

      const model = models.find((m) => m.id === 'plain-local-chat');
      expect(model?.functionCall).toBe(false);
      expect(model?.vision).toBe(false);
      // `['off']` is not a groundable "has reasoning" fact — do not emit true.
      expect(model?.reasoning).not.toBe(true);
    });
  });
});
