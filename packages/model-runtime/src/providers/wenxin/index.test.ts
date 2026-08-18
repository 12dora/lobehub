// @vitest-environment node
import { ModelProvider } from 'model-bank';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeOpenAICompatibleRuntime } from '../../core/BaseAI';
import { testProvider } from '../../providerTestUtils';
import { LobeWenxinAI, mapWenxinModel, params } from './index';

testProvider({
  Runtime: LobeWenxinAI,
  provider: ModelProvider.Wenxin,
  defaultBaseURL: 'https://qianfan.baidubce.com/v2',
  chatDebugEnv: 'DEBUG_WENXIN_CHAT_COMPLETION',
  chatModel: 'ernie-speed-128k',
});

// Mock the console.error to avoid polluting test output
vi.spyOn(console, 'error').mockImplementation(() => {});

let instance: LobeOpenAICompatibleRuntime;

beforeEach(() => {
  instance = new LobeWenxinAI({ apiKey: 'test' });

  // 使用 vi.spyOn 来模拟 chat.completions.create 方法
  vi.spyOn(instance['client'].chat.completions, 'create').mockResolvedValue(
    new ReadableStream() as any,
  );
});

describe('LobeWenxinAI', () => {
  describe('chat', () => {
    it('should with search citations', async () => {
      const data = [
        {
          id: 'as-bhrxwy5fq1',
          object: 'chat.completion.chunk',
          created: 1741000028,
          model: 'ernie-4.0-8k-latest',
          choices: [
            {
              index: 0,
              delta: { content: '今天是**', role: 'assistant' },
              flag: 0,
            },
          ],
          search_results: [
            { index: 1, url: 'http://www.mnw.cn/news/shehui/', title: '社会新闻' },
            {
              index: 2,
              url: 'https://www.chinanews.com.cn/sh/2025/03-01/10376297.shtml',
              title: '中越边民共庆“春龙节”',
            },
            {
              index: 3,
              url: 'https://www.chinanews.com/china/index.shtml',
              title: '中国新闻网_时政',
            },
          ],
        },
        {
          id: 'as-bhrxwy5fq1',
          object: 'chat.completion.chunk',
          created: 1741000028,
          model: 'ernie-4.0-8k-latest',
          choices: [
            {
              index: 0,
              delta: { content: '20' },
              flag: 0,
            },
          ],
        },
      ];

      const mockStream = new ReadableStream({
        start(controller) {
          data.forEach((chunk) => {
            controller.enqueue(chunk);
          });

          controller.close();
        },
      });

      vi.spyOn(instance['client'].chat.completions, 'create').mockResolvedValue(mockStream as any);

      const result = await instance.chat({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'mistralai/mistral-7b-instruct:free',
        temperature: 0,
      });

      const decoder = new TextDecoder();
      const reader = result.body!.getReader();
      const stream: string[] = [];

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stream.push(decoder.decode(value));
      }

      expect(stream).toEqual(
        [
          'id: as-bhrxwy5fq1',
          'event: grounding',
          'data: {"citations":[{"title":"社会新闻","url":"http://www.mnw.cn/news/shehui/"},{"title":"中越边民共庆“春龙节”","url":"https://www.chinanews.com.cn/sh/2025/03-01/10376297.shtml"},{"title":"中国新闻网_时政","url":"https://www.chinanews.com/china/index.shtml"}]}\n',
          'id: as-bhrxwy5fq1',
          'event: text',
          'data: "今天是**"\n',
          'id: as-bhrxwy5fq1',
          'event: text',
          'data: "20"\n',
        ].map((line) => `${line}\n`),
      );

      expect((await reader.read()).done).toBe(true);
    });
  });
});

describe('LobeWenxinAI - Custom Features', () => {
  describe('Debug Configuration', () => {
    it('should disable debug by default', () => {
      delete process.env.DEBUG_WENXIN_CHAT_COMPLETION;
      const result = params.debug.chatCompletion();
      expect(result).toBe(false);
    });

    it('should enable debug when env is set to 1', () => {
      process.env.DEBUG_WENXIN_CHAT_COMPLETION = '1';
      const result = params.debug.chatCompletion();
      expect(result).toBe(true);
    });

    it('should disable debug when env is set to other values', () => {
      process.env.DEBUG_WENXIN_CHAT_COMPLETION = '0';
      const result = params.debug.chatCompletion();
      expect(result).toBe(false);
    });
  });

  describe('handlePollVideoStatus', () => {
    it('should strip /v2 from baseURL when polling video status', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'processing', task_id: 'task-123' }),
      });

      await params.handlePollVideoStatus!('task-123', {
        apiKey: 'test-key',
        baseURL: 'https://qianfan.baidubce.com/v2',
        provider: 'wenxin',
      });

      const url = (global.fetch as any).mock.calls[0][0];
      expect(url).toBe('https://qianfan.baidubce.com/video/generations?task_id=task-123');
      expect(url).not.toContain('/v2/');
    });
  });

  describe('handlePayload', () => {
    it('should transform payload without enabledSearch', () => {
      const payload = {
        model: 'ernie-4.0-8k',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
      };

      const result = params.chatCompletion!.handlePayload!(payload as any);

      expect(result).toEqual({
        model: 'ernie-4.0-8k',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        stream: true,
      });
      expect(result).not.toHaveProperty('web_search');
    });

    it('should transform payload with enabledSearch set to false', () => {
      const payload = {
        model: 'ernie-4.0-8k',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        enabledSearch: false,
      };

      const result = params.chatCompletion!.handlePayload!(payload as any);

      expect(result).toEqual({
        model: 'ernie-4.0-8k',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        stream: true,
      });
      expect(result).not.toHaveProperty('web_search');
    });

    it('should transform payload with enabledSearch set to true', () => {
      const payload = {
        model: 'ernie-4.0-8k',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        enabledSearch: true,
      };

      const result = params.chatCompletion!.handlePayload!(payload as any);

      expect(result).toEqual({
        model: 'ernie-4.0-8k',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        stream: true,
        web_search: {
          enable: true,
          enable_citation: true,
          enable_trace: true,
        },
      });
    });

    it('should add web_search config when enabledSearch is true', () => {
      const payload = {
        model: 'ernie-4.0-8k',
        messages: [{ role: 'user', content: 'What is the weather today?' }],
        enabledSearch: true,
      };

      const result = params.chatCompletion!.handlePayload!(payload as any);

      expect(result.web_search).toEqual({
        enable: true,
        enable_citation: true,
        enable_trace: true,
      });
    });

    it('should preserve all original payload properties except enabledSearch', () => {
      const payload = {
        model: 'ernie-4.0-8k',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.8,
        max_tokens: 2048,
        top_p: 0.9,
        enabledSearch: true,
        custom_field: 'test',
      };

      const result = params.chatCompletion!.handlePayload!(payload as any);

      expect(result).toHaveProperty('model', 'ernie-4.0-8k');
      expect(result).toHaveProperty('messages');
      expect(result).toHaveProperty('temperature', 0.8);
      expect(result).toHaveProperty('max_tokens', 2048);
      expect(result).toHaveProperty('top_p', 0.9);
      expect(result).toHaveProperty('custom_field', 'test');
      expect(result).toHaveProperty('stream', true);
      expect(result).toHaveProperty('web_search');
      expect(result).not.toHaveProperty('enabledSearch');
    });

    it('should always set stream to true', () => {
      const payloadWithoutStream = {
        model: 'ernie-4.0-8k',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result1 = params.chatCompletion!.handlePayload!(payloadWithoutStream as any);
      expect(result1.stream).toBe(true);

      const payloadWithStreamFalse = {
        model: 'ernie-4.0-8k',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      };

      const result2 = params.chatCompletion!.handlePayload!(payloadWithStreamFalse as any);
      expect(result2.stream).toBe(true);
    });

    it('should only send thinking_budget for budget-only models without thinking type', () => {
      const payload = {
        messages: [{ role: 'user', content: 'Hello' }],
        model: 'deepseek-r1-250528',
        thinking: {
          budget_tokens: 2048,
        },
      };

      const result = params.chatCompletion!.handlePayload!(payload as any);

      expect(result.enable_thinking).toBeUndefined();
      expect(result.thinking_budget).toBe(2048);
    });

    it('should not send thinking_budget when thinking budget is not provided', () => {
      const payload = {
        messages: [{ role: 'user', content: 'Hello' }],
        model: 'deepseek-r1-250528',
        thinking: {},
      };

      const result = params.chatCompletion!.handlePayload!(payload as any);

      expect(result.thinking_budget).toBeUndefined();
    });
  });
});

// Wire shape from https://cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y propertyOrder
const documentedWenxinChat = {
  architecture: {
    input_modalities: ['text'],
    modality: 'text->text',
    output_modalities: ['text'],
  },
  context_length: 131_072,
  created: 1_717_200_000,
  id: 'ernie-4.5-turbo-128k',
  max_completions_tokens: 8192,
  max_tokens: 4096,
  object: 'model',
  owned_by: 'Baidu',
  pricing: {
    completion: '0.006',
    prompt: '0.003',
  },
  prompt_tokens: 126_976,
  type: 'chat',
};

const documentedWenxinVision = {
  architecture: {
    input_modalities: ['text', 'image'],
    modality: 'text+image->text',
    output_modalities: ['text'],
  },
  context_length: 32_768,
  created: 1_717_200_000,
  id: 'ernie-4.5-turbo-vl',
  max_completions_tokens: null,
  max_tokens: 4096,
  object: 'model',
  owned_by: 'Baidu',
  prompt_tokens: null,
  type: 'chat',
};

const documentedWenxinImage = {
  architecture: {
    input_modalities: ['text'],
    modality: 'text->image',
    output_modalities: ['image'],
  },
  context_length: null,
  created: 1_717_200_000,
  id: 'irag-1.0',
  max_completions_tokens: null,
  max_tokens: null,
  object: 'model',
  owned_by: 'Baidu',
  pricing: { image: '0.06' },
  prompt_tokens: null,
  type: 'text2image',
};

const documentedWenxinRerank = {
  architecture: {
    input_modalities: ['text'],
    modality: 'text->text',
    output_modalities: ['text'],
  },
  context_length: 8192,
  created: 1_717_200_000,
  id: 'bce-reranker-base',
  max_completions_tokens: null,
  max_tokens: null,
  object: 'model',
  owned_by: 'Baidu',
  prompt_tokens: null,
  type: 'rerank',
};

describe('mapWenxinModel', () => {
  it('maps documented token, type and created fields and leaves CNY pricing unmapped', () => {
    expect(mapWenxinModel(documentedWenxinChat)).toEqual({
      contextWindowTokens: 131_072,
      created: 1_717_200_000,
      id: 'ernie-4.5-turbo-128k',
      imageOutput: undefined,
      maxOutput: 4096,
      type: 'chat',
      vision: undefined,
    });
  });

  it('maps input image modality to vision and treats present-null token fields as unknown', () => {
    expect(mapWenxinModel(documentedWenxinVision)).toEqual({
      contextWindowTokens: 32_768,
      created: 1_717_200_000,
      id: 'ernie-4.5-turbo-vl',
      imageOutput: undefined,
      maxOutput: 4096,
      type: 'chat',
      vision: true,
    });
  });

  it('maps text2image to image and output image modality to imageOutput', () => {
    expect(mapWenxinModel(documentedWenxinImage)).toEqual({
      contextWindowTokens: undefined,
      created: 1_717_200_000,
      id: 'irag-1.0',
      imageOutput: true,
      maxOutput: undefined,
      type: 'image',
      vision: undefined,
    });
  });

  it('leaves open-enum types such as rerank unmapped', () => {
    expect(mapWenxinModel(documentedWenxinRerank).type).toBeUndefined();
  });

  it('does not treat output video as the video-input ability', () => {
    const mapped = mapWenxinModel({
      architecture: {
        input_modalities: ['text'],
        modality: 'text->video',
        output_modalities: ['video'],
      },
      id: 'text2video-example',
      type: 'text2video',
    });

    expect(mapped.type).toBe('video');
    expect(mapped).not.toHaveProperty('video');
  });
});
