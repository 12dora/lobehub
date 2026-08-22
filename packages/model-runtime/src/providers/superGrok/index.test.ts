// @vitest-environment node
import { ModelProvider } from 'model-bank';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testProvider } from '../../providerTestUtils';
import { LobeSuperGrokAI, SUPERGROK_ZDR_FILE_UNSUPPORTED_MESSAGE } from './index';

vi.mock('@lobechat/business-model-bank/model-config', () => ({
  loadModels: vi.fn().mockResolvedValue([]),
}));

testProvider({
  Runtime: LobeSuperGrokAI,
  provider: ModelProvider.SuperGrok,
  defaultBaseURL: 'https://api.x.ai/v1',
  chatDebugEnv: 'DEBUG_SUPERGROK_CHAT_COMPLETION',
  responseDebugEnv: 'DEBUG_SUPERGROK_RESPONSES',
  chatModel: 'grok-4.6',
  test: { useResponsesAPI: true },
});

describe('LobeSuperGrokAI - responses payload', () => {
  let instance: InstanceType<typeof LobeSuperGrokAI>;

  beforeEach(() => {
    instance = new LobeSuperGrokAI({ apiKey: 'test_api_key' });
    vi.spyOn(instance['client'].chat.completions, 'create').mockResolvedValue(
      new ReadableStream() as never,
    );
    vi.spyOn(instance['client'].responses, 'create').mockResolvedValue(
      new ReadableStream() as never,
    );
  });

  it('adds web_search and x_search tools when enabledSearch is true', async () => {
    await instance.chat({
      enabledSearch: true,
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'grok-4.6',
      tools: [{ function: { description: 'test', name: 'test' }, type: 'function' as const }],
    });

    const createCall = (instance['client'].responses.create as Mock).mock.calls[0][0];
    expect(createCall.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function', name: 'test' }),
        { type: 'web_search' },
        { type: 'x_search' },
      ]),
    );
  });

  it('does not add native search tools when enabledSearch is false', async () => {
    await instance.chat({
      enabledSearch: false,
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'grok-4.6',
      tools: [{ function: { description: 'test', name: 'test' }, type: 'function' as const }],
    });

    const createCall = (instance['client'].responses.create as Mock).mock.calls[0][0];
    expect(createCall.tools).not.toContainEqual({ type: 'web_search' });
    expect(createCall.tools).not.toContainEqual({ type: 'x_search' });
  });
});

describe('LobeSuperGrokAI - models', () => {
  let instance: InstanceType<typeof LobeSuperGrokAI>;

  beforeEach(() => {
    instance = new LobeSuperGrokAI({ apiKey: 'test_api_key' });
  });

  it('still processes { id }-only list items via the xai keyword config and catalog', async () => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({
      data: [{ id: 'grok-4.6' }, { id: 'grok-4.5' }],
    } as never);

    const models = await instance.models();

    expect(instance['client'].models.list).toHaveBeenCalled();
    expect(
      models
        .filter((model) => model.type === 'chat')
        .map((model) => model.id)
        .sort(),
    ).toEqual(['grok-4.5', 'grok-4.6']);
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contextWindowTokens: 500_000,
          displayName: 'Grok 4.5',
          functionCall: true,
          id: 'grok-4.5',
          reasoning: true,
          vision: true,
        }),
        expect.objectContaining({
          contextWindowTokens: 500_000,
          displayName: 'Grok 4.6',
          functionCall: true,
          id: 'grok-4.6',
          reasoning: true,
          vision: true,
        }),
        expect.objectContaining({ id: 'grok-imagine-image', type: 'image' }),
        expect.objectContaining({ id: 'grok-imagine-image-quality', type: 'image' }),
        expect.objectContaining({ id: 'grok-imagine-video', type: 'video' }),
      ]),
    );
  });

  it('maps documented /v1/models fields and leaves abilities to keyword fallback', async () => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({
      data: [
        {
          aliases: [],
          cached_prompt_text_token_price: 2000,
          completion_text_token_price: 80_000,
          completion_text_token_price_long_context: 160_000,
          context_length: 256_000,
          created: 1_768_003_200,
          id: 'grok-420-reasoning',
          long_context_threshold: 128_000,
          object: 'model',
          owned_by: 'xai',
          prompt_image_token_price: 0,
          prompt_text_token_price: 20_000,
          prompt_text_token_price_long_context: 40_000,
        },
      ],
    } as never);

    const models = await instance.models();
    const live = models.find((model) => model.id === 'grok-420-reasoning');

    expect(live).toEqual(
      expect.objectContaining({
        contextWindowTokens: 256_000,
        functionCall: true,
        id: 'grok-420-reasoning',
        pricing: {
          units: [
            {
              name: 'textInput',
              strategy: 'tiered',
              tiers: [
                { rate: 2, upTo: 127_999 },
                { rate: 4, upTo: 'infinity' },
              ],
              unit: 'millionTokens',
            },
            {
              name: 'textOutput',
              strategy: 'tiered',
              tiers: [
                { rate: 8, upTo: 127_999 },
                { rate: 16, upTo: 'infinity' },
              ],
              unit: 'millionTokens',
            },
            {
              name: 'textInput_cacheRead',
              strategy: 'tiered',
              tiers: [
                { rate: 0.2, upTo: 127_999 },
                { rate: 0.2, upTo: 'infinity' },
              ],
              unit: 'millionTokens',
            },
          ],
        },
        reasoning: true,
        releasedAt: '2026-01-10',
        search: true,
        vision: true,
      }),
    );
    expect(live).not.toHaveProperty('aliases');
    expect(live).not.toHaveProperty('owned_by');
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'grok-imagine-image', type: 'image' }),
        expect.objectContaining({ id: 'grok-imagine-video', type: 'video' }),
      ]),
    );
  });

  it('leaves abilities to keyword fallback when the list card has only an id', async () => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({
      data: [{ id: 'grok-keyword-only-test-model' }],
    } as never);

    const models = await instance.models();

    expect(models.find((model) => model.id === 'grok-keyword-only-test-model')).toEqual(
      expect.objectContaining({
        functionCall: true,
        id: 'grok-keyword-only-test-model',
        reasoning: false,
        search: true,
        vision: false,
      }),
    );
  });

  it('still unions static image and video cards when the live list is empty', async () => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({ data: [] } as never);

    const models = await instance.models();

    expect(models.map((model) => model.id).sort()).toEqual([
      'grok-imagine-image',
      'grok-imagine-image-quality',
      'grok-imagine-video',
    ]);
  });

  it('does not duplicate generation cards already present in the live list', async () => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({
      data: [{ id: 'grok-4.6' }, { id: 'grok-imagine-image' }],
    } as never);

    const models = await instance.models();

    expect(models.filter((model) => model.id === 'grok-imagine-image')).toHaveLength(1);
    expect(models.find((model) => model.id === 'grok-imagine-image')).toEqual(
      expect.objectContaining({
        id: 'grok-imagine-image',
        parameters: expect.objectContaining({
          imageUrls: { default: [] },
          prompt: { default: '' },
        }),
        type: 'image',
      }),
    );
  });

  it.each([
    { data: undefined, label: 'missing data' },
    { data: { error: { code: 'invalid_token' } }, label: 'a non-array data field' },
  ])('throws when the list answers with $label', async ({ data }) => {
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({ data } as never);

    await expect(instance.models()).rejects.toThrow('SuperGrok models payload was not a list');
  });
});

describe('LobeSuperGrokAI - image and video', () => {
  let instance: InstanceType<typeof LobeSuperGrokAI>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    instance = new LobeSuperGrokAI({ apiKey: 'test_api_key' });
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts image generations to api.x.ai with the injected bearer token', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        data: [{ revised_prompt: 'a cat', url: 'https://cdn.example/out.png' }],
      }),
      ok: true,
    });

    const result = await instance.createImage({
      model: 'grok-imagine-image',
      params: { prompt: 'a cat' },
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://api.x.ai/v1/images/generations',
      expect.objectContaining({
        headers: {
          'Authorization': 'Bearer test_api_key',
          'Content-Type': 'application/json',
        },
        method: 'POST',
      }),
    );
    expect(result).toEqual({ imageUrl: 'https://cdn.example/out.png' });
  });

  it('passes a data URI through to image_url on edits', async () => {
    const dataUri = 'data:image/png;base64,aaaa';
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        data: [{ revised_prompt: 'edit', url: 'https://cdn.example/edited.png' }],
      }),
      ok: true,
    });

    await instance.createImage({
      model: 'grok-imagine-image',
      params: { imageUrls: [dataUri], prompt: 'make it night' },
    });

    const body = JSON.parse((global.fetch as Mock).mock.calls[0][1].body);
    expect(body).toEqual({
      images: [{ type: 'image_url', url: dataUri }],
      model: 'grok-imagine-image',
      prompt: 'make it night',
    });
  });

  it('posts video generations to api.x.ai with the injected bearer token', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ request_id: 'xai-request-123' }),
      ok: true,
    });

    const result = await instance.createVideo({
      model: 'grok-imagine-video',
      params: { prompt: 'a cyberpunk city' },
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://api.x.ai/v1/videos/generations',
      expect.objectContaining({
        headers: {
          'Authorization': 'Bearer test_api_key',
          'Content-Type': 'application/json',
        },
        method: 'POST',
      }),
    );
    expect(result).toEqual({ inferenceId: 'xai-request-123' });
  });

  it('polls video status on the xAI videos API', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ status: 'done', video: { url: 'https://cdn.example/v.mp4' } }),
      ok: true,
    });

    const result = await instance.handlePollVideoStatus('req-1');

    expect(fetch).toHaveBeenCalledWith(
      'https://api.x.ai/v1/videos/req-1',
      expect.objectContaining({
        headers: {
          'Authorization': 'Bearer test_api_key',
          'Content-Type': 'application/json',
        },
        method: 'GET',
      }),
    );
    expect(result).toEqual({ status: 'success', videoUrl: 'https://cdn.example/v.mp4' });
  });
});

describe('LobeSuperGrokAI - native file input', () => {
  const pdfMessage = {
    content: [
      {
        file_url: {
          content: 'EXTRACTED TEXT',
          mimeType: 'application/pdf',
          name: 'report.pdf',
          url: 'data:application/pdf;base64,cGRm',
        },
        type: 'file_url' as const,
      },
      { text: 'summarize', type: 'text' as const },
    ],
    role: 'user' as const,
  };

  const completedJson = () =>
    new Response(JSON.stringify({ id: 'resp', output: [], status: 'completed' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });

  const jsonError = (message: string, status = 400) =>
    new Response(JSON.stringify({ error: { message } }), {
      headers: { 'Content-Type': 'application/json' },
      status,
    });

  const requestUrl = (input: RequestInfo | URL): string => {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input.url;
  };

  const isFilesRequest = (input: RequestInfo | URL) =>
    new URL(requestUrl(input)).pathname.endsWith('/files');

  const isResponsesRequest = (input: RequestInfo | URL) =>
    new URL(requestUrl(input)).pathname.endsWith('/responses');

  const requestBody = (init?: RequestInit): Record<string, any> => {
    expect(typeof init?.body).toBe('string');
    return JSON.parse(init?.body as string);
  };

  const contentParts = (
    body: Record<string, any>,
  ): { file_id?: string; text?: string; type?: string }[] =>
    (Array.isArray(body.input) ? body.input : []).flatMap((item: { content?: unknown }) =>
      Array.isArray(item.content) ? item.content : [],
    );

  const formFieldOrder = (body: unknown): string[] => {
    expect(body).toBeInstanceOf(FormData);
    return [...(body as FormData).keys()];
  };

  it('uploads a data-URI file_url then sends input_file.file_id', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (isFilesRequest(input)) {
        return new Response(JSON.stringify({ id: 'file-abc' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        });
      }
      return completedJson();
    });
    const runtime = new LobeSuperGrokAI({ apiKey: 'test_api_key', fetch: fetchImpl });

    await runtime.chat({
      messages: [pdfMessage],
      model: 'grok-4.6',
      stream: false,
    });

    const filesCall = fetchImpl.mock.calls.find(([input]) => isFilesRequest(input));
    const conversationCall = fetchImpl.mock.calls.find(([input]) => isResponsesRequest(input));

    expect(filesCall).toBeDefined();
    expect(conversationCall).toBeDefined();
    expect(filesCall?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test_api_key' }),
        method: 'POST',
      }),
    );

    const fieldOrder = formFieldOrder(filesCall?.[1]?.body);
    expect(fieldOrder.indexOf('expires_after')).toBeGreaterThanOrEqual(0);
    expect(fieldOrder.indexOf('expires_after')).toBeLessThan(fieldOrder.indexOf('file'));
    expect((filesCall?.[1]?.body as FormData).get('purpose')).toBe('assistants');
    expect((filesCall?.[1]?.body as FormData).get('expires_after')).toBe('86400');

    expect(contentParts(requestBody(conversationCall?.[1]))).toEqual(
      expect.arrayContaining([{ file_id: 'file-abc', type: 'input_file' }]),
    );
    expect(fetchImpl.mock.calls.filter(([input]) => isResponsesRequest(input))).toHaveLength(1);
  });

  it('falls back to files_info in the same conversation request when upload fails without ZDR', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (isFilesRequest(input)) return jsonError('upload exploded', 500);
      return completedJson();
    });
    const runtime = new LobeSuperGrokAI({ apiKey: 'test_api_key', fetch: fetchImpl });

    await runtime.chat({
      messages: [pdfMessage],
      model: 'grok-4.6',
      stream: false,
    });

    const conversationCalls = fetchImpl.mock.calls.filter(([input]) => isResponsesRequest(input));
    expect(conversationCalls).toHaveLength(1);

    const parts = contentParts(requestBody(conversationCalls[0][1]));
    expect(parts.some((part) => part.type === 'input_file')).toBe(false);
    expect(parts.some((part) => part.text?.includes('<files_info>'))).toBe(true);
    expect(parts.some((part) => part.text?.includes('EXTRACTED TEXT'))).toBe(true);
  });

  it('retries a ZDR 4xx on upload once with extracted text and no second upload', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (isFilesRequest(input)) {
        return jsonError('File uploads are unsupported for ZDR customers.');
      }
      return completedJson();
    });
    const runtime = new LobeSuperGrokAI({ apiKey: 'test_api_key', fetch: fetchImpl });

    await runtime.chat({
      messages: [pdfMessage],
      model: 'grok-4.6',
      stream: false,
    });

    expect(fetchImpl.mock.calls.filter(([input]) => isFilesRequest(input))).toHaveLength(1);
    const conversationCalls = fetchImpl.mock.calls.filter(([input]) => isResponsesRequest(input));
    expect(conversationCalls).toHaveLength(1);

    const parts = contentParts(requestBody(conversationCalls[0][1]));
    expect(parts.some((part) => part.type === 'input_file')).toBe(false);
    expect(parts.some((part) => part.text?.includes('<files_info>'))).toBe(true);
    expect(parts.some((part) => part.text?.includes('EXTRACTED TEXT'))).toBe(true);
    expect(parts.some((part) => part.text?.includes('name="report.pdf"'))).toBe(true);
  });

  it('maps a ZDR 4xx without file parts to a clear provider error', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonError('File content is currently unsupported for ZDR customers.'),
    );
    const runtime = new LobeSuperGrokAI({ apiKey: 'test_api_key', fetch: fetchImpl });

    await expect(
      runtime.chat({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'grok-4.6',
        stream: false,
      }),
    ).rejects.toMatchObject({
      errorType: 'ProviderBizError',
      message: SUPERGROK_ZDR_FILE_UNSUPPORTED_MESSAGE,
    });
    expect(fetchImpl.mock.calls.filter(([input]) => isResponsesRequest(input))).toHaveLength(1);
  });
});
