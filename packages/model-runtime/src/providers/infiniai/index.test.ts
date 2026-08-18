// @vitest-environment node
import { ModelProvider } from 'model-bank';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { testProvider } from '../../providerTestUtils';
import { LobeInfiniAI, mapInfiniAIModel, params } from './index';

const loadModelsMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock('@lobechat/business-model-bank/model-config', () => ({
  loadModels: loadModelsMock,
}));

testProvider({
  Runtime: LobeInfiniAI,
  provider: ModelProvider.InfiniAI,
  defaultBaseURL: 'https://cloud.infini-ai.com/maas/v1',
  chatDebugEnv: 'DEBUG_INFINIAI_CHAT_COMPLETION',
  chatModel: 'gpt-3.5-turbo',
  invalidErrorType: 'InvalidProviderAPIKey',
  bizErrorType: 'ProviderBizError',
  test: {
    skipAPICall: true,
    skipErrorHandle: true,
  },
});

describe('LobeInfiniAI - custom features', () => {
  let instance: InstanceType<typeof LobeInfiniAI>;

  beforeEach(() => {
    instance = new LobeInfiniAI({ apiKey: 'test_api_key' });
    vi.spyOn(instance['client'].chat.completions, 'create').mockResolvedValue(
      new ReadableStream() as any,
    );
  });

  describe('handlePayload', () => {
    it('should add enable_thinking when thinking is enabled', async () => {
      await instance.chat({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'deepseek-v3',
        thinking: {
          type: 'enabled',
          budget_tokens: 1000,
        },
      });

      const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
      expect(calledPayload.enable_thinking).toBe(true);
    });

    it('should not add enable_thinking when thinking is disabled', async () => {
      await instance.chat({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'deepseek-v3',
        thinking: {
          budget_tokens: 1000,
          type: 'disabled',
        },
      });

      const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
      expect(calledPayload.enable_thinking).toBe(false);
    });

    it('should set enable_thinking to false when thinking is undefined', async () => {
      await instance.chat({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'deepseek-v3',
      });

      const calledPayload = (instance['client'].chat.completions.create as any).mock.calls[0][0];
      expect(calledPayload.enable_thinking).toBe(false);
    });
  });
});

// Wire shape from https://docs.infini-ai.com/openapi/maas-v1.openapi.yaml
const documentedInfiniChat = {
  context_length: 1_024_000,
  created: 0,
  id: 'deepseek-v4-flash',
  max_output_length: 393_216,
  model_type: '大语言模型',
  object: 'model',
  owned_by: '',
};

const documentedInfiniEmbedding = {
  context_length: 0,
  created: 0,
  id: 'bge-m3',
  max_output_length: 0,
  model_type: '向量模型',
  object: 'model',
  owned_by: '',
};

const documentedInfiniMultimodal = {
  context_length: 32_768,
  created: 0,
  id: 'qwen2.5-vl',
  max_output_length: 4096,
  model_type: '多模态模型',
  object: 'model',
  owned_by: '',
};

describe('mapInfiniAIModel', () => {
  it('maps required context_length, max_output_length and model_type', () => {
    expect(mapInfiniAIModel(documentedInfiniChat)).toEqual({
      contextWindowTokens: 1_024_000,
      created: 0,
      id: 'deepseek-v4-flash',
      maxOutput: 393_216,
      type: 'chat',
    });
  });

  it('coerces documented 0 lengths to undefined and maps 向量模型', () => {
    expect(mapInfiniAIModel(documentedInfiniEmbedding)).toEqual({
      contextWindowTokens: undefined,
      created: 0,
      id: 'bge-m3',
      maxOutput: undefined,
      type: 'embedding',
    });
  });

  it('leaves 多模态模型 and 重排序模型 unmapped and does not infer vision', () => {
    expect(mapInfiniAIModel(documentedInfiniMultimodal)).toEqual({
      contextWindowTokens: 32_768,
      created: 0,
      id: 'qwen2.5-vl',
      maxOutput: 4096,
      type: undefined,
    });
    expect(
      mapInfiniAIModel({
        ...documentedInfiniMultimodal,
        id: 'bge-reranker',
        model_type: '重排序模型',
      }).type,
    ).toBeUndefined();
  });

  it('maps 视频大模型 and 生图大模型', () => {
    expect(mapInfiniAIModel({ ...documentedInfiniChat, model_type: '视频大模型' }).type).toBe(
      'video',
    );
    expect(mapInfiniAIModel({ ...documentedInfiniChat, model_type: '生图大模型' }).type).toBe(
      'image',
    );
  });
});

describe('LobeInfiniAI models', () => {
  it('renames documented fields before processMultiProviderModelList', async () => {
    const mockClient = {
      models: {
        list: vi.fn().mockResolvedValue({ data: [documentedInfiniChat] }),
      },
    } as any;

    const models = await params.models!({ client: mockClient });

    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contextWindowTokens: 1_024_000,
          id: 'deepseek-v4-flash',
          maxOutput: 393_216,
          type: 'chat',
        }),
      ]),
    );
  });
});
