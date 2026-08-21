// @vitest-environment node
import { BRANDING_NAME } from '@lobechat/business-const';
import { CURRENT_VERSION } from '@lobechat/const';
import { DEFAULT_FILE_INLINE_MAX_BYTES, imageUrlToBase64 } from '@lobechat/utils';
import OpenAI from 'openai';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as openaiHelpers from '../../core/contextBuilders/openai';
import { applyModelExtendParams } from '../../utils/modelExtendParams';
import {
  CODEX_CLIENT_VERSION,
  LobeChatGPTAI,
  matchEffortControlForLevels,
  UPSTREAM_REPORTED_ABILITIES,
} from './index';

vi.mock('@lobechat/business-model-bank/model-config', () => ({
  loadModels: vi.fn().mockResolvedValue([]),
}));

vi.mock('@lobechat/utils', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    imageUrlToBase64: vi.fn(),
  };
});

describe('LobeChatGPTAI', () => {
  let instance: InstanceType<typeof LobeChatGPTAI>;

  beforeEach(() => {
    vi.mocked(imageUrlToBase64).mockReset();
    instance = new LobeChatGPTAI({ apiKey: 'access-token', chatgptAccountId: 'account-id' });
    vi.spyOn(instance['client'].chat.completions, 'create').mockResolvedValue(
      new ReadableStream() as never,
    );
    vi.spyOn(instance['client'].responses, 'create').mockResolvedValue(
      new ReadableStream() as never,
    );
  });

  it('configures the Codex endpoint and OAuth account headers', () => {
    const headers = instance['client']['_options'].defaultHeaders;

    expect(instance.baseURL).toBe('https://chatgpt.com/backend-api/codex');
    expect(instance['client'].apiKey).toBe('access-token');
    expect(headers).toEqual(
      expect.objectContaining({
        'ChatGPT-Account-Id': 'account-id',
        'User-Agent': `${BRANDING_NAME}/${CURRENT_VERSION}`,
        'originator': 'lobehub',
        'session-id': expect.any(String),
        'version': CURRENT_VERSION,
      }),
    );
  });

  it('threads forceImageBase64 and forceFileBase64 into Responses conversion', async () => {
    const convertSpy = vi
      .spyOn(openaiHelpers, 'convertOpenAIResponseInputs')
      .mockResolvedValue([{ content: 'mocked', role: 'user' }] as any);

    await instance.chat(
      {
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'gpt-5.5',
        stream: true,
      },
      { user: 'user-id' },
    );

    expect(convertSpy).toHaveBeenCalledWith(
      [{ content: 'Hello', role: 'user' }],
      expect.objectContaining({
        forceFileBase64: true,
        forceImageBase64: true,
        strictToolPairing: true,
      }),
    );
    convertSpy.mockRestore();
  });

  it('inlines HTTP image URLs as data URLs so Codex does not fetch them', async () => {
    vi.mocked(imageUrlToBase64).mockResolvedValue({
      base64: 'imgbytes',
      mimeType: 'image/png',
    });

    await instance.chat(
      {
        messages: [
          {
            content: [
              { text: 'what is this', type: 'text' },
              {
                image_url: { url: 'http://localhost:9000/bucket/cat.png' },
                type: 'image_url',
              },
            ],
            role: 'user',
          },
        ],
        model: 'gpt-5.5',
        stream: true,
      },
      { user: 'user-id' },
    );

    const [request] = (instance['client'].responses.create as Mock).mock.calls[0];
    const imagePart = request.input[0].content.find(
      (part: { type?: string }) => part.type === 'input_image',
    );

    expect(imagePart.image_url).toBe('data:image/png;base64,imgbytes');
    expect(imagePart.image_url.startsWith('data:image/')).toBe(true);
    expect(imageUrlToBase64).toHaveBeenCalledWith('http://localhost:9000/bucket/cat.png');
  });

  it('emits input_file with file_data for document attachments', async () => {
    vi.mocked(imageUrlToBase64).mockResolvedValue({
      base64: 'pdfbytes',
      mimeType: 'application/pdf',
    });

    await instance.chat(
      {
        messages: [
          {
            content: [
              {
                file_url: {
                  content: 'EXTRACTED',
                  mimeType: 'application/pdf',
                  name: 'report.pdf',
                  url: 'http://localhost:9000/report.pdf',
                },
                type: 'file_url',
              },
              { text: 'summarize', type: 'text' },
            ],
            role: 'user',
          },
        ],
        model: 'gpt-5.5',
        stream: true,
      },
      { user: 'user-id' },
    );

    const [request] = (instance['client'].responses.create as Mock).mock.calls[0];
    const filePart = request.input[0].content.find(
      (part: { type?: string }) => part.type === 'input_file',
    );

    expect(filePart).toEqual({
      file_data: 'data:application/pdf;base64,pdfbytes',
      filename: 'report.pdf',
      type: 'input_file',
    });
    expect(imageUrlToBase64).toHaveBeenCalledWith('http://localhost:9000/report.pdf', {
      maxBytes: DEFAULT_FILE_INLINE_MAX_BYTES,
    });
  });

  it('falls back to files_info text without url when a document is over the limit', async () => {
    await instance.chat(
      {
        messages: [
          {
            content: [
              {
                file_url: {
                  content: 'EXTRACTED TEXT',
                  mimeType: 'application/pdf',
                  name: 'huge.pdf',
                  size: DEFAULT_FILE_INLINE_MAX_BYTES + 1,
                  url: 'http://localhost:9000/huge.pdf',
                },
                type: 'file_url',
              },
              { text: 'summarize', type: 'text' },
            ],
            role: 'user',
          },
        ],
        model: 'gpt-5.5',
        stream: true,
      },
      { user: 'user-id' },
    );

    const [request] = (instance['client'].responses.create as Mock).mock.calls[0];
    const textParts = request.input[0].content.filter(
      (part: { type?: string }) => part.type === 'input_text',
    );
    const fallback = textParts.find((part: { text?: string }) =>
      part.text?.includes('<files_info>'),
    );

    expect(fallback.text).toContain('EXTRACTED TEXT');
    expect(fallback.text).toContain('name="huge.pdf"');
    expect(fallback.text).not.toContain('url=');
    expect(fallback.text).not.toContain('http://localhost:9000/huge.pdf');
    expect(imageUrlToBase64).not.toHaveBeenCalled();
  });

  it('always uses Responses API and omits public API output limits', async () => {
    await instance.chat(
      {
        apiMode: 'chatCompletion',
        max_tokens: 4096,
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'gpt-5.5',
        stream: true,
      },
      { user: 'user-id' },
    );

    const [request, requestOptions] = (instance['client'].responses.create as Mock).mock.calls[0];

    expect(request).toMatchObject({
      include: ['reasoning.encrypted_content'],
      input: [{ content: 'Hello', role: 'user' }],
      model: 'gpt-5.5',
      store: false,
      stream: true,
    });
    expect(request.max_output_tokens).toBeUndefined();
    expect(request.safety_identifier).toBeUndefined();
    expect(requestOptions.headers).not.toHaveProperty('x-openai-internal-codex-responses-lite');
    expect(instance['client'].chat.completions.create).not.toHaveBeenCalled();
  });

  it('accepts the connectivity probe contract: maxRetries 0 and no sampling params', async () => {
    // The enterprise admin probe builds this runtime with `maxRetries: 0` so one honest attempt
    // is made instead of three (each paying the full streaming budget), and sends
    // `temperature: 0`, which a reasoning model rejects unless it is pruned.
    const probe = new LobeChatGPTAI({
      apiKey: 'access-token',
      chatgptAccountId: 'account-id',
      maxRetries: 0,
    });
    expect(probe['client'].maxRetries).toBe(0);
    vi.spyOn(probe['client'].responses, 'create').mockResolvedValue(new ReadableStream() as never);

    await probe.chat(
      {
        messages: [{ content: 'Hi', role: 'user' }],
        model: 'gpt-5.5',
        stream: true,
        temperature: 0,
      },
      { user: 'admin-probe' },
    );

    const [request] = (probe['client'].responses.create as Mock).mock.calls[0];

    expect(request).toMatchObject({
      include: ['reasoning.encrypted_content'],
      model: 'gpt-5.5',
      reasoning: expect.objectContaining({ summary: 'auto' }),
      store: false,
      stream: true,
    });
    expect(request.temperature).toBeUndefined();
    expect(request.top_p).toBeUndefined();
    expect(request.safety_identifier).toBeUndefined();
  });

  it.each(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    'uses the Responses Lite request contract for %s',
    async (model) => {
      await instance.chat(
        {
          messages: [
            { content: 'Follow the instructions', role: 'system' },
            { content: 'Check the weather', role: 'user' },
          ],
          model,
          reasoning_effort: 'high',
          tools: [
            {
              function: {
                description: 'Get the weather',
                name: 'get_weather',
                parameters: {
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                  type: 'object',
                },
              },
              type: 'function',
            },
          ],
        },
        { user: 'user-id' },
      );

      const [request, requestOptions] = (instance['client'].responses.create as Mock).mock.calls[0];

      expect(requestOptions.headers).toMatchObject({
        'x-openai-internal-codex-responses-lite': 'true',
      });
      expect(request).toMatchObject({
        input: [
          {
            role: 'developer',
            tools: [
              {
                description: 'Get the weather',
                name: 'get_weather',
                parameters: {
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                  type: 'object',
                },
                type: 'function',
              },
            ],
            type: 'additional_tools',
          },
          { content: 'Follow the instructions', role: 'developer' },
          { content: 'Check the weather', role: 'user' },
        ],
        parallel_tool_calls: false,
        reasoning: { context: 'all_turns', effort: 'high', summary: 'auto' },
        tool_choice: 'auto',
      });
      expect(request.instructions).toBeUndefined();
      expect(request.safety_identifier).toBeUndefined();
      expect(request.tools).toBeUndefined();
    },
  );

  it('uses the Responses Lite contract for structured output', async () => {
    (instance['client'].responses.create as Mock).mockResolvedValue({
      output_text: '{"city":"Hangzhou"}',
    });

    const result = await instance.generateObject(
      {
        messages: [{ content: 'Extract the city', role: 'user' }],
        model: 'gpt-5.6-sol',
        schema: {
          name: 'location',
          schema: {
            properties: { city: { type: 'string' } },
            required: ['city'],
            type: 'object',
          },
        },
      },
      { headers: { 'x-request-id': 'request-id' }, user: 'user-id' },
    );

    const [request, requestOptions] = (instance['client'].responses.create as Mock).mock.calls[0];

    expect(result).toEqual({ city: 'Hangzhou' });
    expect(request).toMatchObject({
      input: [
        { role: 'developer', tools: [], type: 'additional_tools' },
        { content: 'Extract the city', role: 'user' },
      ],
      model: 'gpt-5.6-sol',
      reasoning: { context: 'all_turns' },
      text: {
        format: {
          name: 'location',
          schema: {
            properties: { city: { type: 'string' } },
            required: ['city'],
            type: 'object',
          },
          strict: true,
          type: 'json_schema',
        },
      },
      tool_choice: 'auto',
    });
    expect(request.safety_identifier).toBeUndefined();
    expect(requestOptions.headers).toMatchObject({
      'x-openai-internal-codex-responses-lite': 'true',
      'x-request-id': 'request-id',
    });
  });

  it('uses Responses Lite tools while preserving required tool choice', async () => {
    (instance['client'].responses.create as Mock).mockResolvedValue({
      output: [
        {
          arguments: '{"city":"Hangzhou"}',
          name: 'extract_location',
          type: 'function_call',
        },
      ],
    });

    const result = await instance.generateObject(
      {
        messages: [{ content: 'Extract the city', role: 'user' }],
        model: 'gpt-5.6-sol',
        tools: [
          {
            function: {
              name: 'extract_location',
              parameters: {
                properties: { city: { type: 'string' } },
                required: ['city'],
                type: 'object',
              },
            },
            type: 'function',
          },
        ],
      },
      { user: 'user-id' },
    );

    const [request, requestOptions] = (instance['client'].responses.create as Mock).mock.calls[0];

    expect(result).toEqual([{ arguments: { city: 'Hangzhou' }, name: 'extract_location' }]);
    expect(request).toMatchObject({
      input: [
        {
          role: 'developer',
          tools: [
            {
              name: 'extract_location',
              parameters: {
                properties: { city: { type: 'string' } },
                required: ['city'],
                type: 'object',
              },
              type: 'function',
            },
          ],
          type: 'additional_tools',
        },
        { content: 'Extract the city', role: 'user' },
      ],
      parallel_tool_calls: false,
      reasoning: { context: 'all_turns' },
      tool_choice: 'required',
    });
    expect(request.safety_identifier).toBeUndefined();
    expect(request.tools).toBeUndefined();
    expect(requestOptions.headers).toMatchObject({
      'x-openai-internal-codex-responses-lite': 'true',
    });
  });

  it('reuses OpenAI Responses payload handling for reasoning and web search', async () => {
    await instance.chat({
      enabledSearch: true,
      messages: [{ content: 'Search for this', role: 'user' }],
      model: 'gpt-5.5',
      reasoning_effort: 'high',
    });

    const request = (instance['client'].responses.create as Mock).mock.calls[0][0];

    expect(request.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(request.tools).toContainEqual({ type: 'web_search' });
  });

  describe('matchEffortControlForLevels', () => {
    it('returns the ChatGPT candidate whose levels equal the live set', () => {
      expect(matchEffortControlForLevels(['none', 'low', 'medium', 'high', 'xhigh', 'max'])).toBe(
        'gpt5_6ReasoningEffort',
      );
      expect(matchEffortControlForLevels(['max', 'none', 'high', 'xhigh', 'low', 'medium'])).toBe(
        'gpt5_6ReasoningEffort',
      );
      expect(matchEffortControlForLevels(['low', 'medium', 'high'])).toBe('reasoningEffort');
    });

    it('falls back to the smallest ChatGPT superset and never picks Anthropic opus47Effort', () => {
      expect(matchEffortControlForLevels(['none', 'xhigh'])).toBe('gpt5_2ReasoningEffort');
      expect(matchEffortControlForLevels(['xhigh'])).toBe('gpt5_2ProReasoningEffort');
      expect(matchEffortControlForLevels(['low', 'medium', 'high', 'xhigh', 'max'])).toBe(
        'gpt5_6ReasoningEffort',
      );
    });

    it('returns undefined when no ChatGPT candidate covers the live levels', () => {
      expect(matchEffortControlForLevels(['ultra'])).toBeUndefined();
      expect(matchEffortControlForLevels([])).toBeUndefined();
      expect(matchEffortControlForLevels(['none', 'ultra'])).toBeUndefined();
    });

    it('maps the matched tag to reasoning_effort and never to Anthropic effort', () => {
      const tag = matchEffortControlForLevels(['low', 'medium', 'high', 'xhigh', 'max']);
      expect(tag).toBe('gpt5_6ReasoningEffort');

      const params = applyModelExtendParams({
        chatConfig: { gpt5_6ReasoningEffort: 'high' },
        extendParams: tag ? [tag] : [],
        model: 'codex-live-effort',
      });

      expect(params.reasoning_effort).toBe('high');
      expect(params).not.toHaveProperty('effort');
    });
  });

  describe('models', () => {
    const catalogIds = ['gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-image-2'];

    const mockModelsGet = (payload: unknown) =>
      vi.spyOn(instance['client'], 'get').mockResolvedValue(payload as never);

    const mockModelsGetReject = (error: unknown) =>
      vi.spyOn(instance['client'], 'get').mockRejectedValue(error);

    it('uses the live Codex list when the endpoint answers', async () => {
      mockModelsGet({
        models: [
          {
            context_window: 272_000,
            display_name: 'GPT-5.5',
            input_modalities: ['text', 'image'],
            priority: 2,
            slug: 'gpt-5.5',
            supported_reasoning_levels: [{ effort: 'medium' }],
          },
          {
            context_window: 128_000,
            display_name: 'Codex Only',
            priority: 1,
            slug: 'codex-only-model',
          },
        ],
      });

      const models = await instance.models();

      expect(instance['client'].get).toHaveBeenCalledWith('/models', {
        query: { client_version: CODEX_CLIENT_VERSION },
      });
      expect(models.map((model) => model.id)).toEqual([
        'codex-only-model',
        'gpt-5.5',
        'gpt-image-2',
      ]);
      expect(models).toEqual([
        expect.objectContaining({
          displayName: 'Codex Only',
          functionCall: true,
          id: 'codex-only-model',
        }),
        expect.objectContaining({
          contextWindowTokens: 272_000,
          displayName: 'GPT-5.5',
          functionCall: true,
          id: 'gpt-5.5',
          reasoning: true,
          vision: true,
        }),
        expect.objectContaining({
          id: 'gpt-image-2',
          type: 'image',
        }),
      ]);
    });

    it('maps supported_reasoning_levels onto the matching effort tag and swaps the bank family', async () => {
      mockModelsGet({
        models: [
          {
            context_window: 272_000,
            display_name: 'GPT-5.5',
            slug: 'gpt-5.5',
            supported_reasoning_levels: [
              { effort: 'none' },
              { effort: 'low' },
              { effort: 'medium' },
              { effort: 'high' },
              { effort: 'xhigh' },
              { effort: 'max' },
            ],
          },
          {
            display_name: 'Codex Live Only',
            slug: 'codex-live-effort',
            supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        ],
      });

      const models = await instance.models();
      const gpt55 = models.find((model) => model.id === 'gpt-5.5');
      const liveOnly = models.find((model) => model.id === 'codex-live-effort');

      expect(gpt55?.settings?.extendParams).toEqual([
        'textVerbosity',
        'preserveThinking',
        'gpt5_6ReasoningEffort',
      ]);
      expect(liveOnly).toEqual(
        expect.objectContaining({
          id: 'codex-live-effort',
          reasoning: true,
          settings: { extendParams: ['gpt5_6ReasoningEffort'] },
        }),
      );
    });

    it('leaves bank effort tags untouched when live levels do not match a registry set', async () => {
      mockModelsGet({
        models: [
          {
            slug: 'gpt-5.5',
            supported_reasoning_levels: [{ effort: 'ultra' }],
          },
        ],
      });

      const model = (await instance.models()).find((item) => item.id === 'gpt-5.5');

      expect(model?.settings?.extendParams).toEqual([
        'gpt5_2ReasoningEffort',
        'textVerbosity',
        'preserveThinking',
      ]);
    });

    it('reports explicit false vision and reasoning when upstream arrays are present', async () => {
      mockModelsGet({
        models: [
          {
            context_window: 32_000,
            display_name: 'Text only',
            input_modalities: ['text'],
            slug: 'codex-text-only',
            supported_reasoning_levels: [],
          },
        ],
      });

      const model = (await instance.models()).find((item) => item.id === 'codex-text-only');

      expect(model).toMatchObject({
        functionCall: true,
        id: 'codex-text-only',
        reasoning: false,
        vision: false,
      });
      expect(model).toEqual(
        expect.objectContaining({
          [UPSTREAM_REPORTED_ABILITIES]: expect.objectContaining({
            functionCall: true,
            reasoning: false,
            vision: false,
          }),
        }),
      );
    });

    it('skips hidden Codex models and keeps an empty gated list empty', async () => {
      mockModelsGet({
        models: [
          { slug: 'gpt-5.5', visibility: 'list' },
          { slug: 'codex-auto-review', visibility: 'hide' },
        ],
      });

      const listed = await instance.models();
      expect(listed.map((model) => model.id)).toEqual(['gpt-5.5', 'gpt-image-2']);
      expect(listed.every((model) => model.id !== 'codex-auto-review')).toBe(true);

      mockModelsGet({ models: [] });
      const gated = await instance.models();
      expect(gated.map((model) => model.id)).toEqual(['gpt-image-2']);
      expect(gated[0]).toMatchObject({ id: 'gpt-image-2', type: 'image' });
      expect(instance['client'].get).toHaveBeenLastCalledWith('/models', {
        query: { client_version: CODEX_CLIENT_VERSION },
      });
    });

    it('still accepts the OpenAI { data } list shape', async () => {
      mockModelsGet({ data: [{ id: 'gpt-5.5' }, { id: 'codex-only-model' }] });

      const models = await instance.models();

      expect(models.map((model) => model.id).sort()).toEqual([
        'codex-only-model',
        'gpt-5.5',
        'gpt-image-2',
      ]);
      expect(models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            contextWindowTokens: 272_000,
            id: 'gpt-5.5',
          }),
          expect.objectContaining({ id: 'codex-only-model' }),
        ]),
      );
    });

    it.each([
      { reason: '404s', status: 404 },
      { reason: '405s', status: 405 },
      { reason: '501s', status: 501 },
    ])('returns the chatgpt catalog when Codex /models $reason', async ({ status }) => {
      mockModelsGetReject(Object.assign(new Error(`HTTP ${status}`), { status }));

      const models = await instance.models();

      expect(models.map((model) => model.id).sort()).toEqual(catalogIds);
      expect(models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            contextWindowTokens: 272_000,
            id: 'gpt-5.5',
          }),
        ]),
      );
    });

    it('propagates a 400 from Codex /models instead of publishing the curated catalog', async () => {
      const badRequest = Object.assign(new Error('Field required'), { status: 400 });
      mockModelsGetReject(badRequest);

      await expect(instance.models()).rejects.toBe(badRequest);
    });

    it('propagates a 401 from Codex /models instead of publishing the curated catalog', async () => {
      const unauthorized = Object.assign(new Error('HTTP 401'), { status: 401 });
      mockModelsGetReject(unauthorized);

      await expect(instance.models()).rejects.toBe(unauthorized);
    });

    it('propagates a 404 that carries an authentication error instead of publishing the catalog', async () => {
      const unauthorized = OpenAI.APIError.generate(
        404,
        {
          error: {
            code: 'invalid_token',
            message: 'Invalid token',
            type: 'authentication_error',
          },
        },
        'Invalid token',
        new Headers(),
      );
      mockModelsGetReject(unauthorized);

      await expect(instance.models()).rejects.toBe(unauthorized);
    });

    it('returns the chatgpt catalog when the live payload cannot be parsed', async () => {
      mockModelsGet({ data: 'not-a-list' });

      const models = await instance.models();

      expect(models.map((model) => model.id).sort()).toEqual(catalogIds);
    });

    it('propagates transport failures from Codex /models', async () => {
      const transport = new Error('socket hang up');
      mockModelsGetReject(transport);

      await expect(instance.models()).rejects.toBe(transport);
    });

    it('keeps a live gpt-image-2 row that has no parameters of its own', async () => {
      mockModelsGet({
        models: [
          { display_name: 'GPT-5.5', slug: 'gpt-5.5' },
          { display_name: 'GPT Image 2 Live', slug: 'gpt-image-2' },
        ],
      });

      const models = await instance.models();
      const image = models.find((model) => model.id === 'gpt-image-2');

      expect(image).toMatchObject({
        displayName: 'GPT Image 2 Live',
        id: 'gpt-image-2',
        type: 'image',
      });
      expect(image?.parameters).toEqual(
        expect.objectContaining({
          imageUrls: expect.objectContaining({ maxCount: 5 }),
          prompt: expect.objectContaining({ default: '' }),
        }),
      );
    });
  });

  describe('createImage', () => {
    it('posts JSON generations and never calls images.generate', async () => {
      vi.spyOn(instance['client'], 'post').mockResolvedValue({
        created: 1,
        data: [{ b64_json: 'abc123' }],
        size: '1024x1024',
      } as never);
      const generateSpy = vi.spyOn(instance['client'].images, 'generate');

      const result = await instance.createImage({
        model: 'gpt-image-2',
        params: { prompt: 'a small red cube' },
      });

      expect(generateSpy).not.toHaveBeenCalled();
      expect(instance['client'].post).toHaveBeenCalledWith(
        '/images/generations',
        expect.objectContaining({
          body: expect.objectContaining({
            model: 'gpt-image-2',
            prompt: 'a small red cube',
          }),
          headers: expect.objectContaining({
            'originator': 'lobehub',
            'x-codex-image-turn-id': expect.any(String),
          }),
        }),
      );
      expect(result).toEqual({
        height: 1024,
        imageUrl: 'data:image/png;base64,abc123',
        width: 1024,
      });
    });
  });
});
