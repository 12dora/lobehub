import {
  AttachmentInlineLimitError,
  DEFAULT_FILE_INLINE_MAX_BYTES,
  imageUrlToBase64,
  videoUrlToBase64,
} from '@lobechat/utils';
import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenAIChatMessage } from '../../types';
import type { SignatureScope } from '../../utils/signatureScope';
import { serializeScopedSignature } from '../../utils/signatureScope';
import { parseDataUri } from '../../utils/uriParser';
import {
  convertImageUrlToFile,
  convertMessageContent,
  convertOpenAIMessages,
  convertOpenAIResponseInputs,
  type ExtendedChatCompletionContentPart,
} from './openai';

// 模拟依赖
vi.mock('@lobechat/utils', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    imageUrlToBase64: vi.fn(),
    videoUrlToBase64: vi.fn(),
  };
});
vi.mock('../../utils/uriParser');

describe('convertMessageContent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return the same content if not image_url type', async () => {
    const content = { type: 'text', text: 'Hello' } as OpenAI.ChatCompletionContentPart;
    const result = await convertMessageContent(content);
    expect(result).toEqual(content);
  });

  // `file_url` parts are only emitted for models with `abilities.files`; an
  // OpenAI-compatible endpoint would reject the raw object, so downgrade it.
  it('should downgrade a native file_url part to a text placeholder', async () => {
    const content = {
      file_url: { name: 'report.pdf', url: 'https://example.com/report.pdf' },
      type: 'file_url',
    } as unknown as OpenAI.ChatCompletionContentPart;

    const result = await convertMessageContent(content);

    expect(result).toEqual({ text: '[file omitted: report.pdf]', type: 'text' });
  });

  it('should convert image URL to base64 when necessary', async () => {
    // 设置环境变量
    process.env.LLM_VISION_IMAGE_USE_BASE64 = '1';

    const content = {
      type: 'image_url',
      image_url: { url: 'https://example.com/image.jpg' },
    } as OpenAI.ChatCompletionContentPart;

    vi.mocked(parseDataUri).mockReturnValue({ type: 'url', base64: null, mimeType: null });
    vi.mocked(imageUrlToBase64).mockResolvedValue({
      base64: 'base64String',
      mimeType: 'image/jpeg',
    });

    const result = await convertMessageContent(content);

    expect(result).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,base64String' },
    });

    expect(parseDataUri).toHaveBeenCalledWith('https://example.com/image.jpg');
    expect(imageUrlToBase64).toHaveBeenCalledWith('https://example.com/image.jpg');
  });

  it('should not convert image URL when not necessary', async () => {
    process.env.LLM_VISION_IMAGE_USE_BASE64 = undefined;

    const content = {
      type: 'image_url',
      image_url: { url: 'https://example.com/image.jpg' },
    } as OpenAI.ChatCompletionContentPart;

    vi.mocked(parseDataUri).mockReturnValue({ type: 'url', base64: null, mimeType: null });

    const result = await convertMessageContent(content);

    expect(result).toEqual(content);
    expect(imageUrlToBase64).not.toHaveBeenCalled();
  });

  it('should convert image URL when forceImageBase64 is true', async () => {
    process.env.LLM_VISION_IMAGE_USE_BASE64 = undefined;

    const content = {
      type: 'image_url',
      image_url: { url: 'https://example.com/image.jpg' },
    } as OpenAI.ChatCompletionContentPart;

    vi.mocked(parseDataUri).mockReturnValue({ type: 'url', base64: null, mimeType: null });
    vi.mocked(imageUrlToBase64).mockResolvedValue({
      base64: 'forcedBase64',
      mimeType: 'image/jpeg',
    });

    const result = await convertMessageContent(content, { forceImageBase64: true });

    expect(result).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,forcedBase64' },
    });

    expect(imageUrlToBase64).toHaveBeenCalledWith('https://example.com/image.jpg');
  });

  it('should pass ChatGPT inlineImage options through to imageUrlToBase64', async () => {
    process.env.LLM_VISION_IMAGE_USE_BASE64 = undefined;

    const content = {
      type: 'image_url',
      image_url: { url: 'https://example.com/image.jpg' },
    } as OpenAI.ChatCompletionContentPart;

    vi.mocked(parseDataUri).mockReturnValue({ type: 'url', base64: null, mimeType: null });
    vi.mocked(imageUrlToBase64).mockResolvedValue({
      base64: 'forcedBase64',
      mimeType: 'image/jpeg',
    });

    await convertMessageContent(content, {
      forceImageBase64: true,
      inlineImage: { maxBytes: 20 * 1024 * 1024, ownOriginOnly: true },
    });

    expect(imageUrlToBase64).toHaveBeenCalledWith('https://example.com/image.jpg', {
      maxBytes: 20 * 1024 * 1024,
      ownOriginOnly: true,
    });
  });

  it('should reject an oversized data URL when inlineImage.maxBytes is set', async () => {
    const content = {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,YWJj' },
    } as OpenAI.ChatCompletionContentPart;

    vi.mocked(parseDataUri).mockReturnValue({
      type: 'base64',
      base64: 'YWJj',
      mimeType: 'image/png',
    });

    await expect(
      convertMessageContent(content, {
        forceImageBase64: true,
        inlineImage: { maxBytes: 2, ownOriginOnly: true },
      }),
    ).rejects.toThrow(AttachmentInlineLimitError);
    expect(imageUrlToBase64).not.toHaveBeenCalled();
  });

  it('should allow a data URL whose decoded size equals inlineImage.maxBytes', async () => {
    const content = {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,YWI=' },
    } as OpenAI.ChatCompletionContentPart;

    vi.mocked(parseDataUri).mockReturnValue({
      type: 'base64',
      base64: 'YWI=',
      mimeType: 'image/png',
    });

    await expect(
      convertMessageContent(content, {
        forceImageBase64: true,
        inlineImage: { maxBytes: 2, ownOriginOnly: true },
      }),
    ).resolves.toEqual(content);
  });

  it('should convert video URL to base64 when necessary', async () => {
    process.env.LLM_VISION_VIDEO_USE_BASE64 = '1';

    const content: ExtendedChatCompletionContentPart = {
      type: 'video_url',
      video_url: { url: 'https://example.com/video.mp4' },
    };

    vi.mocked(parseDataUri).mockReturnValue({ type: 'url', base64: null, mimeType: null });
    vi.mocked(videoUrlToBase64).mockResolvedValue({
      base64: 'base64String',
      mimeType: 'video/mp4',
    });

    const result = await convertMessageContent(content);

    expect(result).toEqual({
      type: 'video_url',
      video_url: { url: 'data:video/mp4;base64,base64String' },
    });

    expect(parseDataUri).toHaveBeenCalledWith('https://example.com/video.mp4');
    expect(videoUrlToBase64).toHaveBeenCalledWith('https://example.com/video.mp4');

    process.env.LLM_VISION_VIDEO_USE_BASE64 = undefined;
  });

  it('should not convert video URL when not necessary', async () => {
    process.env.LLM_VISION_VIDEO_USE_BASE64 = undefined;

    const content: ExtendedChatCompletionContentPart = {
      type: 'video_url',
      video_url: { url: 'https://example.com/video.mp4' },
    };

    vi.mocked(parseDataUri).mockReturnValue({ type: 'url', base64: null, mimeType: null });

    const result = await convertMessageContent(content);

    expect(result).toEqual(content);
    expect(videoUrlToBase64).not.toHaveBeenCalled();
  });

  it('should convert video URL when forceVideoBase64 is true', async () => {
    process.env.LLM_VISION_VIDEO_USE_BASE64 = undefined;

    const content: ExtendedChatCompletionContentPart = {
      type: 'video_url',
      video_url: { url: 'https://example.com/video.mp4' },
    };

    vi.mocked(parseDataUri).mockReturnValue({ type: 'url', base64: null, mimeType: null });
    vi.mocked(videoUrlToBase64).mockResolvedValue({
      base64: 'forcedBase64',
      mimeType: 'video/mp4',
    });

    const result = await convertMessageContent(content, { forceVideoBase64: true });

    expect(result).toEqual({
      type: 'video_url',
      video_url: { url: 'data:video/mp4;base64,forcedBase64' },
    });

    expect(videoUrlToBase64).toHaveBeenCalledWith('https://example.com/video.mp4');
  });

  it('should return original content when video conversion fails', async () => {
    process.env.LLM_VISION_VIDEO_USE_BASE64 = '1';

    const content: ExtendedChatCompletionContentPart = {
      type: 'video_url',
      video_url: { url: 'https://example.com/video.mp4' },
    };

    vi.mocked(parseDataUri).mockReturnValue({ type: 'url', base64: null, mimeType: null });
    vi.mocked(videoUrlToBase64).mockRejectedValue(new Error('Conversion failed'));

    const result = await convertMessageContent(content);

    expect(result).toEqual(content);

    process.env.LLM_VISION_VIDEO_USE_BASE64 = undefined;
  });
});

describe('convertOpenAIMessages', () => {
  it('should convert string content messages', async () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ] as OpenAI.ChatCompletionMessageParam[];

    const result = await convertOpenAIMessages(messages);

    expect(result).toEqual(messages);
  });

  it('should convert array content messages', async () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } },
        ],
      },
    ] as OpenAI.ChatCompletionMessageParam[];

    vi.spyOn(Promise, 'all');
    vi.mocked(parseDataUri).mockReturnValue({ type: 'url', base64: null, mimeType: null });
    vi.mocked(imageUrlToBase64).mockResolvedValue({
      base64: 'base64String',
      mimeType: 'image/jpeg',
    });

    process.env.LLM_VISION_IMAGE_USE_BASE64 = '1';

    const result = await convertOpenAIMessages(messages);

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/jpeg;base64,base64String' },
          },
        ],
      },
    ]);

    expect(Promise.all).toHaveBeenCalledTimes(2); // 一次用于消息数组，一次用于内容数组

    process.env.LLM_VISION_IMAGE_USE_BASE64 = undefined;
  });
  it('should convert array content messages', async () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } },
        ],
      },
    ] as OpenAI.ChatCompletionMessageParam[];

    vi.spyOn(Promise, 'all');
    vi.mocked(parseDataUri).mockReturnValue({ type: 'url', base64: null, mimeType: null });
    vi.mocked(imageUrlToBase64).mockResolvedValue({
      base64: 'base64String',
      mimeType: 'image/jpeg',
    });

    const result = await convertOpenAIMessages(messages);

    expect(result).toEqual(messages);

    expect(Promise.all).toHaveBeenCalledTimes(2); // 一次用于消息数组，一次用于内容数组
  });

  it('should filter out reasoning field from messages', async () => {
    const messages = [
      {
        role: 'assistant',
        content: 'Hello',
        reasoning: { content: 'some reasoning', duration: 100 },
      },
      { role: 'user', content: 'Hi' },
    ] as any;

    const result = await convertOpenAIMessages(messages);

    expect(result).toEqual([
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Hi' },
    ]);
    // Ensure reasoning field is removed
    expect((result[0] as any).reasoning).toBeUndefined();
  });

  it('should preserve reasoning_content field from messages (for DeepSeek compatibility)', async () => {
    const messages = [
      {
        role: 'assistant',
        content: 'Hello',
        reasoning_content: 'some reasoning content',
      },
      { role: 'user', content: 'Hi' },
    ] as any;

    const result = await convertOpenAIMessages(messages);

    expect(result).toEqual([
      { role: 'assistant', content: 'Hello', reasoning_content: 'some reasoning content' },
      { role: 'user', content: 'Hi' },
    ]);
    // Ensure reasoning_content field is preserved
    expect((result[0] as any).reasoning_content).toBe('some reasoning content');
  });

  it('should filter internal thinking content parts but preserve reasoning_content', async () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            signature: 'sig_123',
            thinking: 'internal reasoning',
            type: 'thinking',
          },
          {
            text: 'Visible answer',
            type: 'text',
          },
        ],
        reasoning_content: 'internal reasoning',
      },
    ] as any;

    const result = await convertOpenAIMessages(messages);

    expect(result).toEqual([
      {
        role: 'assistant',
        content: [{ text: 'Visible answer', type: 'text' }],
        reasoning_content: 'internal reasoning',
      },
    ]);
  });

  it('should filter out reasoning but preserve reasoning_content field', async () => {
    const messages = [
      {
        role: 'assistant',
        content: 'Hello',
        reasoning: { content: 'some reasoning', duration: 100 },
        reasoning_content: 'some reasoning content',
      },
    ] as any;

    const result = await convertOpenAIMessages(messages);

    expect(result).toEqual([
      { role: 'assistant', content: 'Hello', reasoning_content: 'some reasoning content' },
    ]);
    // Ensure reasoning object is removed but reasoning_content is preserved
    expect((result[0] as any).reasoning).toBeUndefined();
    expect((result[0] as any).reasoning_content).toBe('some reasoning content');
  });

  describe('DeepSeek reasoning_content compatibility', () => {
    it('should derive reasoning_content from reasoning.content for deepseek models', async () => {
      const messages = [
        {
          role: 'assistant',
          content: 'Answer with tool call',
          reasoning: { content: 'planned tool invocation', duration: 100 },
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
          ],
        },
      ] as any;

      const result = await convertOpenAIMessages(messages, { model: 'deepseek-v4-flash' });

      expect((result[0] as any).reasoning_content).toBe('planned tool invocation');
      expect((result[0] as any).tool_calls).toHaveLength(1);
      expect((result[0] as any).reasoning).toBeUndefined();
    });

    it('should force empty reasoning_content for deepseek-v4 thinking-mode assistant messages without reasoning', async () => {
      const messages = [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
          ],
        },
      ] as any;

      const result = await convertOpenAIMessages(messages, { model: 'deepseek-v4-pro' });

      expect((result[0] as any).reasoning_content).toBe('');
    });

    it('should force empty reasoning_content for deepseek-reasoner', async () => {
      const messages = [{ role: 'assistant', content: 'Hi' }] as any;

      const result = await convertOpenAIMessages(messages, { model: 'deepseek-reasoner' });

      expect((result[0] as any).reasoning_content).toBe('');
    });

    it('should match provider-prefixed deepseek model ids (e.g. Deepseek/deepseek-v4-pro)', async () => {
      const messages = [{ role: 'assistant', content: 'Hi' }] as any;

      const result = await convertOpenAIMessages(messages, {
        model: 'Deepseek/deepseek-v4-pro',
      });

      expect((result[0] as any).reasoning_content).toBe('');
    });

    it('should not force reasoning_content for non-thinking deepseek models', async () => {
      const messages = [{ role: 'assistant', content: 'Hi' }] as any;

      const result = await convertOpenAIMessages(messages, { model: 'deepseek-chat' });

      expect((result[0] as any).reasoning_content).toBeUndefined();
    });

    it('should leave non-deepseek models untouched', async () => {
      const messages = [
        {
          role: 'assistant',
          content: 'Hi',
          reasoning: { content: 'unrelated', duration: 10 },
        },
      ] as any;

      const result = await convertOpenAIMessages(messages, { model: 'gpt-4o-mini' });

      expect((result[0] as any).reasoning_content).toBeUndefined();
      expect((result[0] as any).reasoning).toBeUndefined();
    });

    it('should not touch non-assistant messages', async () => {
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'tool', content: '{}', tool_call_id: 'call_1' },
      ] as any;

      const result = await convertOpenAIMessages(messages, { model: 'deepseek-v4-flash' });

      expect((result[0] as any).reasoning_content).toBeUndefined();
      expect((result[1] as any).reasoning_content).toBeUndefined();
    });

    it('should preserve existing reasoning_content over reasoning.content', async () => {
      const messages = [
        {
          role: 'assistant',
          content: 'Hi',
          reasoning: { content: 'should be ignored', duration: 10 },
          reasoning_content: 'kept',
        },
      ] as any;

      const result = await convertOpenAIMessages(messages, { model: 'deepseek-v4-flash' });

      expect((result[0] as any).reasoning_content).toBe('kept');
    });
  });
});

describe('convertOpenAIResponseInputs', () => {
  it('should replay encrypted reasoning from a persisted message for the exact scope', async () => {
    const reasoningSignatureScope: SignatureScope = { fingerprint: 'a'.repeat(32) };
    const messages: OpenAIChatMessage[] = [
      {
        content: 'hello',
        reasoning: {
          content: 'reasoning content',
          signature: serializeScopedSignature(
            'encrypted-reasoning-content',
            reasoningSignatureScope,
            'reasoning',
          ),
        },
        role: 'assistant',
      },
    ];

    const result = await convertOpenAIResponseInputs(messages, { reasoningSignatureScope });

    expect(result).toEqual([
      {
        encrypted_content: 'encrypted-reasoning-content',
        summary: [{ text: 'reasoning content', type: 'summary_text' }],
        type: 'reasoning',
      },
      { content: 'hello', role: 'assistant' },
    ]);
  });

  it('should keep the visible summary but reject foreign and legacy encrypted reasoning', async () => {
    const sourceScope: SignatureScope = { fingerprint: 'a'.repeat(32) };
    const targetScope: SignatureScope = { fingerprint: 'b'.repeat(32) };
    const baseMessage: OpenAIChatMessage = {
      content: 'hello',
      reasoning: {
        content: 'reasoning content',
        signature: serializeScopedSignature(
          'encrypted-reasoning-content',
          sourceScope,
          'reasoning',
        ),
      },
      role: 'assistant',
    };

    const foreignResult = await convertOpenAIResponseInputs([baseMessage], {
      reasoningSignatureScope: targetScope,
    });
    const legacyResult = await convertOpenAIResponseInputs(
      [{ ...baseMessage, reasoning: { ...baseMessage.reasoning, signature: 'legacy-signature' } }],
      { reasoningSignatureScope: sourceScope },
    );

    const expected = [
      { summary: [{ text: 'reasoning content', type: 'summary_text' }], type: 'reasoning' },
      { content: 'hello', role: 'assistant' },
    ];
    expect(foreignResult).toEqual(expected);
    expect(legacyResult).toEqual(expected);
  });

  it('should replay complete reasoning items in original order for the exact scope', async () => {
    const reasoningSignatureScope: SignatureScope = { fingerprint: 'a'.repeat(32) };
    const messages: OpenAIChatMessage[] = [
      {
        content: 'hello',
        reasoning: {
          content: 'first summary',
          responseItems: [
            {
              encrypted_content: serializeScopedSignature(
                'encrypted-part-1',
                reasoningSignatureScope,
                'reasoning',
              ),
              id: 'rs_1',
              status: 'completed',
              summary: [{ text: 'first summary', type: 'summary_text' }],
              type: 'reasoning',
            },
            {
              encrypted_content: serializeScopedSignature(
                'encrypted-part-2',
                reasoningSignatureScope,
                'reasoning',
              ),
              id: 'rs_2',
              status: 'completed',
              summary: [],
              type: 'reasoning',
            },
          ],
        },
        role: 'assistant',
      },
    ];

    const result = await convertOpenAIResponseInputs(messages, { reasoningSignatureScope });

    expect(result).toEqual([
      {
        encrypted_content: 'encrypted-part-1',
        id: 'rs_1',
        status: 'completed',
        summary: [{ text: 'first summary', type: 'summary_text' }],
        type: 'reasoning',
      },
      {
        encrypted_content: 'encrypted-part-2',
        id: 'rs_2',
        status: 'completed',
        summary: [],
        type: 'reasoning',
      },
      { content: 'hello', role: 'assistant' },
    ]);
  });

  it('should replay hidden reasoning items that have no visible summary', async () => {
    const reasoningSignatureScope: SignatureScope = { fingerprint: 'a'.repeat(32) };
    const responseItem = {
      encrypted_content: serializeScopedSignature(
        'hidden-encrypted',
        reasoningSignatureScope,
        'reasoning',
      ),
      id: 'rs_hidden',
      summary: [],
      type: 'reasoning' as const,
    };

    const result = await convertOpenAIResponseInputs(
      [
        {
          content: 'hello',
          reasoning: { responseItems: [responseItem] },
          role: 'assistant',
        },
      ],
      { reasoningSignatureScope },
    );

    expect(result).toEqual([
      { ...responseItem, encrypted_content: 'hidden-encrypted' },
      { content: 'hello', role: 'assistant' },
    ]);
  });

  it('should fall back to the visible summary when any reasoning item is foreign-scoped', async () => {
    const sourceScope: SignatureScope = { fingerprint: 'a'.repeat(32) };
    const targetScope: SignatureScope = { fingerprint: 'b'.repeat(32) };
    const result = await convertOpenAIResponseInputs(
      [
        {
          content: 'hello',
          reasoning: {
            content: 'visible summary',
            responseItems: [
              {
                encrypted_content: serializeScopedSignature(
                  'encrypted-part-1',
                  sourceScope,
                  'reasoning',
                ),
                id: 'rs_1',
                summary: [{ text: 'visible summary', type: 'summary_text' }],
                type: 'reasoning',
              },
            ],
            signature: serializeScopedSignature('encrypted-part-1', sourceScope, 'reasoning'),
          },
          role: 'assistant',
        },
      ],
      { reasoningSignatureScope: targetScope },
    );

    expect(result).toEqual([
      { summary: [{ text: 'visible summary', type: 'summary_text' }], type: 'reasoning' },
      { content: 'hello', role: 'assistant' },
    ]);
  });

  it('should strip item ids when replaying summary-only reasoning items', async () => {
    const result = await convertOpenAIResponseInputs([
      {
        content: 'hello',
        reasoning: {
          content: 'summary only',
          responseItems: [
            {
              id: 'rs_summary_only',
              summary: [{ text: 'summary only', type: 'summary_text' }],
              type: 'reasoning',
            },
          ],
        },
        role: 'assistant',
      },
    ]);

    expect(result).toEqual([
      { summary: [{ text: 'summary only', type: 'summary_text' }], type: 'reasoning' },
      { content: 'hello', role: 'assistant' },
    ]);
  });
  it('应该正确转换普通文本消息', async () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];

    const result = await convertOpenAIResponseInputs(messages);

    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);
  });

  it('应该正确转换带有工具调用的消息', async () => {
    const messages: OpenAIChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: {
              name: 'test_function',
              arguments: '{"key": "value"}',
            },
          },
        ],
      },
    ];

    const result = await convertOpenAIResponseInputs(messages);

    expect(result).toEqual([
      {
        arguments: 'test_function',
        call_id: 'call_123',
        name: 'test_function',
        type: 'function_call',
      },
    ]);
  });

  it('应该正确转换工具响应消息', async () => {
    const messages: OpenAIChatMessage[] = [
      {
        role: 'tool',
        content: 'Function result',
        tool_call_id: 'call_123',
      },
    ];

    const result = await convertOpenAIResponseInputs(messages);

    expect(result).toEqual([
      {
        call_id: 'call_123',
        output: 'Function result',
        type: 'function_call_output',
      },
    ]);
  });

  it('应该正确转换包含图片的消息', async () => {
    const messages: OpenAIChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Here is an image' },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/jpeg;base64,test123',
            },
          },
        ],
      },
    ];

    const result = await convertOpenAIResponseInputs(messages);

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Here is an image' },
          {
            type: 'input_image',
            image_url: 'data:image/jpeg;base64,test123',
          },
        ],
      },
    ]);
  });

  it('应该正确转换包含视频的消息', async () => {
    const messages: OpenAIChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Here is a video' },
          {
            type: 'video_url',
            video_url: {
              url: 'data:video/mp4;base64,test123',
            },
          },
        ],
      },
    ];

    const result = await convertOpenAIResponseInputs(messages);

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Here is a video' },
          {
            type: 'input_video',
            video_url: 'data:video/mp4;base64,test123',
          },
        ],
      },
    ]);
  });

  it('应该正确转换包含图片和视频的混合消息', async () => {
    const messages: OpenAIChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Here is an image and a video' },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/jpeg;base64,test123',
            },
          },
          {
            type: 'video_url',
            video_url: {
              url: 'data:video/mp4;base64,test456',
            },
          },
        ],
      },
    ];

    const result = await convertOpenAIResponseInputs(messages);

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Here is an image and a video' },
          {
            type: 'input_image',
            image_url: 'data:image/jpeg;base64,test123',
          },
          {
            type: 'input_video',
            video_url: 'data:video/mp4;base64,test456',
          },
        ],
      },
    ]);
  });

  it('应该正确处理带有无效 video_url 的消息', async () => {
    const messages: OpenAIChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Here is a video' },
          {
            type: 'video_url',
            video_url: {
              url: '',
            },
          },
        ],
      },
    ];

    const result = await convertOpenAIResponseInputs(messages);

    expect(result).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'Here is a video' }],
      },
    ]);
  });

  it('应该正确处理混合类型的消息序列', async () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'I need help with a function' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_456',
            type: 'function',
            function: {
              name: 'get_data',
              arguments: '{}',
            },
          },
        ],
      },
      {
        role: 'tool',
        content: '{"result": "success"}',
        tool_call_id: 'call_456',
      },
    ];

    const result = await convertOpenAIResponseInputs(messages);

    expect(result).toEqual([
      { role: 'user', content: 'I need help with a function' },
      {
        arguments: 'get_data',
        call_id: 'call_456',
        name: 'get_data',
        type: 'function_call',
      },
      {
        call_id: 'call_456',
        output: '{"result": "success"}',
        type: 'function_call_output',
      },
    ]);
  });

  it('should filter orphan tool calls when strictToolPairing is enabled', async () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'Use tools carefully' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_paired',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"city":"Hangzhou"}',
            },
          },
          {
            id: 'call_orphan',
            type: 'function',
            function: {
              name: 'get_news',
              arguments: '{"topic":"AI"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        content: '{"temp":22}',
        tool_call_id: 'call_paired',
      },
    ];

    const result = await convertOpenAIResponseInputs(messages, { strictToolPairing: true });

    expect(result).toEqual([
      { role: 'user', content: 'Use tools carefully' },
      {
        arguments: '{"city":"Hangzhou"}',
        call_id: 'call_paired',
        name: 'get_weather',
        type: 'function_call',
      },
      {
        call_id: 'call_paired',
        output: '{"temp":22}',
        type: 'function_call_output',
      },
    ]);
  });

  it('should drop assistant message with all orphaned tool_calls in strict mode', async () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'Do something' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_orphan_1',
            type: 'function',
            function: { name: 'fn_a', arguments: '{}' },
          },
          {
            id: 'call_orphan_2',
            type: 'function',
            function: { name: 'fn_b', arguments: '{}' },
          },
        ],
      },
      { role: 'assistant', content: 'Final answer' },
    ];

    const result = await convertOpenAIResponseInputs(messages, { strictToolPairing: true });

    // The assistant message with all-orphaned tool_calls should produce no items,
    // NOT fall through to the default builder which would spread tool_calls back.
    expect(result).toEqual([
      { role: 'user', content: 'Do something' },
      { role: 'assistant', content: 'Final answer' },
    ]);
  });

  it('should extract reasoning.content into a separate reasoning item', async () => {
    const messages: OpenAIChatMessage[] = [
      { content: 'system prompts', role: 'system' },
      { content: '你好', role: 'user' },
      {
        content: 'hello',
        role: 'assistant',
        reasoning: { content: 'reasoning content', duration: 2706 },
      },
      { content: '杭州天气如何', role: 'user' },
    ];

    const result = await convertOpenAIResponseInputs(messages);

    expect(result).toEqual([
      { content: 'system prompts', role: 'developer' },
      { content: '你好', role: 'user' },
      { summary: [{ text: 'reasoning content', type: 'summary_text' }], type: 'reasoning' },
      { content: 'hello', role: 'assistant' },
      { content: '杭州天气如何', role: 'user' },
    ]);
  });

  it('should preserve message order when earlier messages have async content (images)', async () => {
    const messages: OpenAIChatMessage[] = [
      { content: 'system prompts', role: 'system' },
      {
        content: [
          { type: 'text', text: 'describe this image' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc123' } },
        ],
        role: 'user',
      },
      {
        content: 'The image shows a green car.',
        role: 'assistant',
        reasoning: { content: 'analyzing the image', duration: 3000 },
      },
      { content: '1 + 1 = ?', role: 'user' },
    ];

    const result = await convertOpenAIResponseInputs(messages);

    expect(result).toEqual([
      { content: 'system prompts', role: 'developer' },
      {
        content: [
          { type: 'input_text', text: 'describe this image' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,abc123' },
        ],
        role: 'user',
      },
      { summary: [{ text: 'analyzing the image', type: 'summary_text' }], type: 'reasoning' },
      { content: 'The image shows a green car.', role: 'assistant' },
      { content: '1 + 1 = ?', role: 'user' },
    ]);
  });

  it('should handle openai and claude mixed message', async () => {
    // See: https://github.com/lobehub/lobehub/pull/12017
    const messages: OpenAIChatMessage[] = [
      {
        content: 'system prompts',
        role: 'system',
      },
      {
        content: '你是谁',
        role: 'user',
      },
      {
        content: [
          {
            signature: 'E',
            thinking: 'thoughts',
            type: 'thinking',
          },
          {
            text: '我是 Claude',
            type: 'text',
          },
        ],
        role: 'assistant',
        reasoning: {
          content: 'The user is asking',
          duration: 110,
          signature: 'E',
        },
      },
    ];
    const result = await convertOpenAIResponseInputs(messages);
    expect(result).toEqual([
      { content: 'system prompts', role: 'developer' },
      { content: '你是谁', role: 'user' },
      {
        summary: [{ text: 'The user is asking', type: 'summary_text' }],
        type: 'reasoning',
      },
      {
        content: [{ text: '我是 Claude', type: 'output_text' }],
        role: 'assistant',
      },
    ]);
  });

  it('should drop assistant image content for Responses API input', async () => {
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          {
            image_url: { url: 'data:image/jpeg;base64,abc123' },
            type: 'image_url',
          },
        ],
        role: 'assistant',
      },
    ];

    const result = await convertOpenAIResponseInputs(messages);

    expect(result).toEqual([]);
  });

  it('should keep assistant text and drop unsupported assistant media for Responses API input', async () => {
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          {
            text: 'Here is the generated image.',
            type: 'text',
          },
          {
            image_url: { url: 'data:image/jpeg;base64,abc123' },
            type: 'image_url',
          },
          {
            video_url: { url: 'data:video/mp4;base64,def456' },
            type: 'video_url',
          },
        ],
        role: 'assistant',
      },
    ];

    const result = await convertOpenAIResponseInputs(messages);

    expect(result).toEqual([
      {
        content: [{ text: 'Here is the generated image.', type: 'output_text' }],
        role: 'assistant',
      },
    ]);
  });

  it('should pass forceVideoBase64 to convertMessageContent in video_url branch', async () => {
    process.env.LLM_VISION_VIDEO_USE_BASE64 = undefined;

    const messages: OpenAIChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Here is a video' },
          {
            type: 'video_url',
            video_url: {
              url: 'https://example.com/video.mp4',
            },
          },
        ],
      },
    ];

    vi.mocked(parseDataUri).mockReturnValue({ type: 'url', base64: null, mimeType: null });
    vi.mocked(videoUrlToBase64).mockResolvedValue({
      base64: 'forcedBase64',
      mimeType: 'video/mp4',
    });

    const result = await convertOpenAIResponseInputs(messages, { forceVideoBase64: true });

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Here is a video' },
          {
            type: 'input_video',
            video_url: 'data:video/mp4;base64,forcedBase64',
          },
        ],
      },
    ]);

    expect(videoUrlToBase64).toHaveBeenCalledWith('https://example.com/video.mp4');
  });

  it('should pass forceImageBase64 to convertMessageContent in image_url branch', async () => {
    process.env.LLM_VISION_IMAGE_USE_BASE64 = undefined;

    const messages: OpenAIChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Here is an image' },
          {
            type: 'image_url',
            image_url: {
              url: 'https://example.com/image.jpg',
            },
          },
        ],
      },
    ];

    vi.mocked(parseDataUri).mockReturnValue({ type: 'url', base64: null, mimeType: null });
    vi.mocked(imageUrlToBase64).mockResolvedValue({
      base64: 'forcedBase64',
      mimeType: 'image/jpeg',
    });

    const result = await convertOpenAIResponseInputs(messages, { forceImageBase64: true });

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Here is an image' },
          {
            type: 'input_image',
            image_url: 'data:image/jpeg;base64,forcedBase64',
          },
        ],
      },
    ]);

    expect(imageUrlToBase64).toHaveBeenCalledWith('https://example.com/image.jpg');
  });

  describe('native file_url (forceFileBase64)', () => {
    beforeEach(() => {
      vi.mocked(imageUrlToBase64).mockReset();
    });

    it('should drop file_url parts when forceFileBase64 is unset', async () => {
      const messages: OpenAIChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'summarize' },
            {
              type: 'file_url',
              file_url: {
                content: 'EXTRACTED',
                name: 'report.pdf',
                url: 'http://localhost:9000/report.pdf',
              },
            } as any,
          ],
        },
      ];

      const result = await convertOpenAIResponseInputs(messages);

      expect(result).toEqual([
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'summarize' }],
        },
      ]);
      expect(imageUrlToBase64).not.toHaveBeenCalled();
    });

    it('should emit input_file with file_data when forceFileBase64 is true', async () => {
      const fileUrl = 'http://localhost:9000/report.pdf';
      const messages: OpenAIChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'summarize' },
            {
              file_url: {
                content: 'EXTRACTED',
                mimeType: 'application/pdf',
                name: 'report.pdf',
                url: fileUrl,
              },
              type: 'file_url',
            } as any,
          ],
        },
      ];

      vi.mocked(parseDataUri).mockReturnValue({ type: 'url', base64: null, mimeType: null });
      vi.mocked(imageUrlToBase64).mockResolvedValue({
        base64: 'pdfbytes',
        mimeType: 'application/pdf',
      });

      const result = await convertOpenAIResponseInputs(messages, { forceFileBase64: true });

      expect(result).toEqual([
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'summarize' },
            {
              file_data: 'data:application/pdf;base64,pdfbytes',
              filename: 'report.pdf',
              type: 'input_file',
            },
          ],
        },
      ]);
      expect(imageUrlToBase64).toHaveBeenCalledWith(fileUrl, {
        maxBytes: DEFAULT_FILE_INLINE_MAX_BYTES,
      });
    });

    it('should emit input_file for a data URL whose decoded size equals the limit', async () => {
      const messages: OpenAIChatMessage[] = [
        {
          role: 'user',
          content: [
            {
              file_url: {
                content: 'EXTRACTED',
                mimeType: 'application/pdf',
                name: 'tiny.pdf',
                url: 'data:application/pdf;base64,YWI=',
              },
              type: 'file_url',
            } as any,
          ],
        },
      ];

      vi.mocked(parseDataUri).mockReturnValue({
        type: 'base64',
        base64: 'YWI=',
        mimeType: 'application/pdf',
      });

      const result = await convertOpenAIResponseInputs(messages, {
        forceFileBase64: true,
        inlineFile: { maxBytes: 2, ownOriginOnly: true },
      });
      const content = (result[0] as { content: Array<{ file_data?: string; type: string }> })
        .content;

      expect(content[0]).toEqual({
        file_data: 'data:application/pdf;base64,YWI=',
        filename: 'tiny.pdf',
        type: 'input_file',
      });
      expect(imageUrlToBase64).not.toHaveBeenCalled();
    });

    it('should fall back to files_info without url when a data URL is one byte over the limit', async () => {
      const messages: OpenAIChatMessage[] = [
        {
          role: 'user',
          content: [
            {
              file_url: {
                content: 'EXTRACTED',
                mimeType: 'application/pdf',
                name: 'tiny.pdf',
                url: 'data:application/pdf;base64,YWJj',
              },
              type: 'file_url',
            } as any,
          ],
        },
      ];

      vi.mocked(parseDataUri).mockReturnValue({
        type: 'base64',
        base64: 'YWJj',
        mimeType: 'application/pdf',
      });

      const result = await convertOpenAIResponseInputs(messages, {
        forceFileBase64: true,
        inlineFile: { maxBytes: 2, ownOriginOnly: true },
      });
      const content = (result[0] as { content: Array<{ text?: string; type: string }> }).content;

      expect(content[0].type).toBe('input_text');
      expect(content[0].text).toContain('EXTRACTED');
      expect(content[0].text).not.toContain('url=');
      expect(imageUrlToBase64).not.toHaveBeenCalled();
    });

    it('should fall back to files_info without url when the document is over the limit', async () => {
      const onAttachmentOverLimit = vi.fn();
      const fileUrl = 'http://localhost:9000/huge.pdf';
      const messages: OpenAIChatMessage[] = [
        {
          role: 'user',
          content: [
            {
              file_url: {
                content: 'EXTRACTED TEXT',
                fileId: 'file-1',
                mimeType: 'application/pdf',
                name: 'huge.pdf',
                size: DEFAULT_FILE_INLINE_MAX_BYTES + 1,
                url: fileUrl,
              },
              type: 'file_url',
            } as any,
            { type: 'text', text: 'summarize' },
          ],
        },
      ];

      const result = await convertOpenAIResponseInputs(messages, {
        forceFileBase64: true,
        onAttachmentOverLimit,
      });

      const content = (result[0] as { content: Array<{ text?: string; type: string }> }).content;
      const fallback = content.find((part) => part.type === 'input_text');

      expect(fallback?.text).toContain('<files_info>');
      expect(fallback?.text).toContain('EXTRACTED TEXT');
      expect(fallback?.text).toContain('name="huge.pdf"');
      expect(fallback?.text).not.toContain('url=');
      expect(fallback?.text).not.toContain(fileUrl);
      expect(imageUrlToBase64).not.toHaveBeenCalled();
      expect(onAttachmentOverLimit).toHaveBeenCalledWith([
        expect.objectContaining({
          filename: 'huge.pdf',
          reason: 'over_limit',
          url: fileUrl,
        }),
      ]);
    });

    it('should fall back to files_info without url for non-document types', async () => {
      const onAttachmentOverLimit = vi.fn();
      const fileUrl = 'http://localhost:9000/archive.zip';
      const messages: OpenAIChatMessage[] = [
        {
          role: 'user',
          content: [
            {
              file_url: {
                content: 'cannot parse zip',
                mimeType: 'application/zip',
                name: 'archive.zip',
                url: fileUrl,
              },
              type: 'file_url',
            } as any,
          ],
        },
      ];

      const result = await convertOpenAIResponseInputs(messages, {
        forceFileBase64: true,
        onAttachmentOverLimit,
      });

      const content = (result[0] as { content: Array<{ text?: string; type: string }> }).content;
      expect(content[0].type).toBe('input_text');
      expect(content[0].text).toContain('<files_info>');
      expect(content[0].text).not.toContain('url=');
      expect(content[0].text).not.toContain(fileUrl);
      expect(imageUrlToBase64).not.toHaveBeenCalled();
      expect(onAttachmentOverLimit).toHaveBeenCalledWith([
        expect.objectContaining({ filename: 'archive.zip', reason: 'unsupported_type' }),
      ]);
    });

    it('should fall back when inlining throws AttachmentInlineLimitError', async () => {
      const fileUrl = 'http://localhost:9000/report.pdf';
      const messages: OpenAIChatMessage[] = [
        {
          role: 'user',
          content: [
            {
              file_url: {
                content: 'EXTRACTED',
                mimeType: 'application/pdf',
                name: 'report.pdf',
                url: fileUrl,
              },
              type: 'file_url',
            } as any,
          ],
        },
      ];

      vi.mocked(parseDataUri).mockReturnValue({ type: 'url', base64: null, mimeType: null });
      vi.mocked(imageUrlToBase64).mockRejectedValue(
        new AttachmentInlineLimitError(
          DEFAULT_FILE_INLINE_MAX_BYTES,
          DEFAULT_FILE_INLINE_MAX_BYTES + 8,
        ),
      );

      const result = await convertOpenAIResponseInputs(messages, { forceFileBase64: true });
      const content = (result[0] as { content: Array<{ text?: string; type: string }> }).content;

      expect(content[0].type).toBe('input_text');
      expect(content[0].text).toContain('EXTRACTED');
      expect(content[0].text).not.toContain('url=');
    });

    it('should emit input_file with file_id when uploadFile succeeds', async () => {
      const messages: OpenAIChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'summarize' },
            {
              file_url: {
                content: 'EXTRACTED',
                mimeType: 'application/pdf',
                name: 'report.pdf',
                url: 'data:application/pdf;base64,cGRm',
              },
              type: 'file_url',
            } as any,
          ],
        },
      ];

      vi.mocked(parseDataUri).mockReturnValue({
        type: 'base64',
        base64: 'cGRm',
        mimeType: 'application/pdf',
      });
      const uploadFile = vi.fn().mockResolvedValue({ fileId: 'file-abc' });

      const result = await convertOpenAIResponseInputs(messages, {
        forceFileBase64: true,
        uploadFile,
      });

      expect(result).toEqual([
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'summarize' },
            { file_id: 'file-abc', type: 'input_file' },
          ],
        },
      ]);
      expect(uploadFile).toHaveBeenCalledTimes(1);
      expect(uploadFile).toHaveBeenCalledWith({
        bytes: new Uint8Array([0x70, 0x64, 0x66]),
        filename: 'report.pdf',
        mimeType: 'application/pdf',
      });
      expect(imageUrlToBase64).not.toHaveBeenCalled();
    });

    it('should fall back to files_info when uploadFile fails with a non-ZDR error', async () => {
      const messages: OpenAIChatMessage[] = [
        {
          role: 'user',
          content: [
            {
              file_url: {
                content: 'EXTRACTED',
                mimeType: 'application/pdf',
                name: 'report.pdf',
                url: 'data:application/pdf;base64,cGRm',
              },
              type: 'file_url',
            } as any,
          ],
        },
      ];

      vi.mocked(parseDataUri).mockReturnValue({
        type: 'base64',
        base64: 'cGRm',
        mimeType: 'application/pdf',
      });
      const uploadFile = vi.fn().mockRejectedValue(new Error('upload exploded'));

      const result = await convertOpenAIResponseInputs(messages, {
        forceFileBase64: true,
        uploadFile,
      });
      const content = (result[0] as { content: Array<{ text?: string; type: string }> }).content;

      expect(content[0].type).toBe('input_text');
      expect(content[0].text).toContain('EXTRACTED');
      expect(content[0].text).toContain('<files_info>');
      expect(content[0].text).not.toContain('url=');
    });

    it('should propagate a ZDR refusal from uploadFile', async () => {
      const messages: OpenAIChatMessage[] = [
        {
          role: 'user',
          content: [
            {
              file_url: {
                content: 'EXTRACTED',
                mimeType: 'application/pdf',
                name: 'report.pdf',
                url: 'data:application/pdf;base64,cGRm',
              },
              type: 'file_url',
            } as any,
          ],
        },
      ];

      vi.mocked(parseDataUri).mockReturnValue({
        type: 'base64',
        base64: 'cGRm',
        mimeType: 'application/pdf',
      });
      const zdrError = Object.assign(new Error('File uploads are unsupported for ZDR customers.'), {
        status: 400,
      });
      const uploadFile = vi.fn().mockRejectedValue(zdrError);

      await expect(
        convertOpenAIResponseInputs(messages, { forceFileBase64: true, uploadFile }),
      ).rejects.toBe(zdrError);
    });
  });
});

describe('convertImageUrlToFile', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Data URL handling', () => {
    it('should convert PNG data URL to File object correctly', async () => {
      const base64Data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      const dataUrl = `data:image/png;base64,${base64Data}`;

      const result = await convertImageUrlToFile(dataUrl);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('name', 'image.png');
      expect(result).toHaveProperty('type', 'image/png');
      expect(result).toHaveProperty('size');
      expect(result.size).toBeGreaterThan(0);
    });

    it('should convert JPEG data URL to File object correctly', async () => {
      const base64Data =
        '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA9BQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
      const dataUrl = `data:image/jpeg;base64,${base64Data}`;

      const result = await convertImageUrlToFile(dataUrl);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('name', 'image.jpeg');
      expect(result).toHaveProperty('type', 'image/jpeg');
      expect(result).toHaveProperty('size');
      expect(result.size).toBeGreaterThan(0);
    });

    it('should convert WebP data URL to File object correctly', async () => {
      const base64Data = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAAAAJaQAA6g=';
      const dataUrl = `data:image/webp;base64,${base64Data}`;

      const result = await convertImageUrlToFile(dataUrl);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('name', 'image.webp');
      expect(result).toHaveProperty('type', 'image/webp');
      expect(result).toHaveProperty('size');
      expect(result.size).toBeGreaterThan(0);
    });
  });

  describe('HTTP URL handling', () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
      // Mock global fetch using vi.stubGlobal for better isolation
      vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    });

    it('should convert HTTP URL to File object correctly', async () => {
      const mockArrayBuffer = new ArrayBuffer(8);
      const mockHeaders = new Headers();
      mockHeaders.set('content-type', 'image/jpeg');

      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(mockArrayBuffer),
        headers: mockHeaders,
      } satisfies Partial<Response>);

      const result = await convertImageUrlToFile('https://example.com/image.jpg');

      expect(mockFetch).toHaveBeenCalledWith('https://example.com/image.jpg');
      expect(result).toBeDefined();
      expect(result).toHaveProperty('name', 'image.jpeg');
      expect(result).toHaveProperty('type', 'image/jpeg');
      expect(result).toHaveProperty('size');
      expect(result.size).toEqual(8);
    });

    it('should handle different content types from HTTP response headers', async () => {
      const testCases = [
        { contentType: 'image/jpeg', expectedExtension: 'jpeg' },
        { contentType: 'image/png', expectedExtension: 'png' },
        { contentType: 'image/webp', expectedExtension: 'webp' },
        { contentType: null, expectedExtension: 'png' }, // default fallback
      ];

      for (const testCase of testCases) {
        const mockArrayBuffer = new ArrayBuffer(8);
        const mockHeaders = new Headers();
        if (testCase.contentType) {
          mockHeaders.set('content-type', testCase.contentType);
        }

        mockFetch.mockResolvedValue({
          ok: true,
          arrayBuffer: () => Promise.resolve(mockArrayBuffer),
          headers: mockHeaders,
        } satisfies Partial<Response>);

        const result = await convertImageUrlToFile('https://example.com/image.jpg');

        expect(result).toHaveProperty('name', `image.${testCase.expectedExtension}`);
        expect(result).toHaveProperty('type', testCase.contentType || 'image/png');

        vi.clearAllMocks();
      }
    });

    it('should throw error when HTTP request fails', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        statusText: 'Not Found',
      } satisfies Partial<Response>);

      await expect(convertImageUrlToFile('https://example.com/nonexistent.jpg')).rejects.toThrow(
        'Failed to fetch image from https://example.com/nonexistent.jpg: Not Found',
      );

      expect(mockFetch).toHaveBeenCalledWith('https://example.com/nonexistent.jpg');
    });

    it('should throw error when network request fails', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(convertImageUrlToFile('https://example.com/image.jpg')).rejects.toThrow(
        'Network error',
      );

      expect(mockFetch).toHaveBeenCalledWith('https://example.com/image.jpg');
    });
  });

  describe('Edge cases', () => {
    it('should handle malformed data URL gracefully', async () => {
      const malformedDataUrl = 'data:invalid-format';

      // 这个测试可能会抛出错误，我们需要适当处理
      await expect(convertImageUrlToFile(malformedDataUrl)).rejects.toThrow();
    });
  });
});
