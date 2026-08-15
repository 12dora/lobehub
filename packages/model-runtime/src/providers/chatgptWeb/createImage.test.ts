// @vitest-environment node
import { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntimeErrorType } from '../../types/error';
import { base64ToBytes, bytesToBase64 } from './binary';
import type { ChatGPTWebClient } from './client';
import { createChatGPTWebImage, IMAGE_UPSTREAM_MODEL, MAX_REFERENCE_BYTES } from './createImage';
import { ChatGPTWebError } from './errors';
import type { ConversationEvent } from './types';

vi.mock('@lobechat/ssrf-safe-fetch', () => ({ ssrfSafeFetch: vi.fn() }));

// ------------------------------------------------------------------ fixtures

const u32be = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

const png = (width: number, height: number, tint = 0): Uint8Array =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    0x49,
    0x48,
    0x44,
    0x52,
    ...u32be(width),
    ...u32be(height),
    8,
    6,
    0,
    0,
    tint,
  ]);

const jpeg = (width: number, height: number): Uint8Array =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);

const RESULT_PNG = png(1024, 1024, 7);

/** `Uint8Array` is a valid body at runtime; the DOM lib type omits it. */
const asBody = (input: Uint8Array): BodyInit => input as unknown as BodyInit;

/** A signed reference URL whose query must never reach a log or an error. */
const SIGNED_REFERENCE_URL = 'https://blob.example.com/ref.png?sig=SUPER_SECRET_SIGNATURE';

const toolNode = (pointer: string, createTime = 1) => ({
  message: {
    author: { role: 'tool' },
    content: {
      content_type: 'multimodal_text',
      parts: [{ asset_pointer: pointer, content_type: 'image_asset_pointer' }],
    },
    create_time: createTime,
    metadata: { async_task_type: 'image_gen' },
  },
});

async function* streamOf(events: ConversationEvent[], error?: unknown) {
  for (const event of events) yield event;
  if (error) throw error;
}

const HAPPY_EVENTS: ConversationEvent[] = [
  { conversationId: 'conv-1', type: 'conversation.start' },
  { delta: 'drawing…', text: 'drawing…', type: 'text.delta' },
  {
    assetPointer: 'file-service://file_000000001111222233334444',
    fileId: 'file_000000001111222233334444',
    pointerKind: 'file-service',
    type: 'image.pointer',
  },
  { conversationId: 'conv-1', endTurn: true, type: 'done' },
];

const createClient = (overrides: Partial<Record<string, any>> = {}) =>
  ({
    downloadBytes: vi.fn(async () => ({ bytes: RESULT_PNG, mimeType: 'image/png' })),
    getAttachmentDownloadUrl: vi.fn(
      async (_conversationId: string, id: string) => `https://cdn/attachment/${id}`,
    ),
    getChatRequirements: vi.fn(async () => ({
      proofToken: 'proof',
      soToken: '',
      token: 'requirements',
      turnstileToken: '',
    })),
    getConversation: vi.fn(async () => ({ mapping: {} })),
    getFileDownloadUrl: vi.fn(async (id: string) => `https://cdn/${id}`),
    hideConversation: vi.fn(async () => {}),
    listTasks: vi.fn(async () => []),
    prepareConversation: vi.fn(async () => ({ conduitToken: 'conduit' })),
    streamConversation: vi.fn(() => streamOf(HAPPY_EVENTS)),
    uploadFile: vi.fn(async (bytes: Uint8Array, meta: any) => ({
      fileId: `file-${meta.name}`,
      height: meta.height,
      kind: 'image',
      mimeType: meta.mimeType,
      name: meta.name,
      size: bytes.length,
      width: meta.width,
    })),
    ...overrides,
  }) as unknown as ChatGPTWebClient & Record<string, ReturnType<typeof vi.fn>>;

/** Drive a promise to settlement while the poll loop's timers are faked. */
const settle = async <T>(promise: Promise<T>): Promise<T> => {
  let done = false;
  const tracked = promise.then(
    (value) => {
      done = true;
      return value;
    },
    (error) => {
      done = true;
      throw error;
    },
  );
  tracked.catch(() => {});

  for (let tick = 0; tick < 600 && !done; tick += 1) await vi.advanceTimersByTimeAsync(1000);
  return tracked;
};

const generate = (client: ChatGPTWebClient, params: Record<string, any> = {}) =>
  settle(
    createChatGPTWebImage(
      { model: 'gpt-image-2', params: { prompt: 'a small red cube', ...params } as any },
      { client, provider: 'chatgptweb' },
    ),
  );

/** Burn `ms` of the (faked) clock inside a mocked client call. */
const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A promise that only ever settles when the given signal aborts. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason));
  });

/**
 * Standard padded base64 for `size` bytes, built without allocating them — the
 * boundary cases are about the ENCODED length, which is what the guard reads.
 */
const paddedBase64 = (size: number): string => {
  const whole = Math.floor(size / 3);
  const rest = size % 3;
  return 'A'.repeat(whole * 4) + (rest === 0 ? '' : rest === 1 ? 'AA==' : 'AAA=');
};

/** A Response whose body is produced lazily, so a huge size costs little. */
const streamedResponse = (totalBytes: number, init: ResponseInit = {}) => {
  const chunk = 1024 * 1024;
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) {
          controller.close();
          return;
        }
        const size = Math.min(chunk, totalBytes - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size));
      },
    }),
    init,
  );
};

// --------------------------------------------------------------------- tests

describe('createChatGPTWebImage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('returns the generated image as a data URL and hides the conversation', async () => {
    const client = createClient({
      getConversation: vi.fn(async () => ({
        mapping: { node: toolNode('file-service://file_000000001111222233334444') },
      })),
    });

    const result = await generate(client);

    expect(result).toEqual({
      height: 1024,
      imageUrl: `data:image/png;base64,${bytesToBase64(RESULT_PNG)}`,
      width: 1024,
    });
    expect(client.getFileDownloadUrl).toHaveBeenCalledWith(
      'file_000000001111222233334444',
      expect.anything(),
    );
    expect(client.hideConversation).toHaveBeenCalledWith('conv-1', expect.anything());
    // every deadline timer this call armed is disposed of by the time it returns
    expect(vi.getTimerCount()).toBe(0);

    const [body] = (client.streamConversation as any).mock.calls[0];
    expect(body.model).toBe(IMAGE_UPSTREAM_MODEL);
    expect(body.system_hints).toEqual(['picture_v2']);
    expect(body.messages[0].content).toEqual({ content_type: 'text', parts: ['a small red cube'] });
  });

  it('uploads reference images with probed dimensions and sends them as pointers', async () => {
    vi.mocked(ssrfSafeFetch).mockResolvedValue(
      new Response(asBody(png(64, 32)), { headers: { 'content-type': 'image/png' } }),
    );

    const client = createClient({
      getConversation: vi.fn(async () => ({
        mapping: { node: toolNode('file-service://file_000000001111222233334444') },
      })),
    });

    await generate(client, {
      imageUrls: [
        `data:image/png;base64,${bytesToBase64(jpeg(800, 600))}`,
        'https://example.com/ref.png',
      ],
    });

    expect(client.uploadFile).toHaveBeenCalledTimes(2);
    // the declared mime type is ignored in favour of what the bytes say
    expect((client.uploadFile as any).mock.calls[0][1]).toEqual({
      height: 600,
      kind: 'image',
      mimeType: 'image/jpeg',
      name: 'image_1.jpg',
      width: 800,
    });
    expect((client.uploadFile as any).mock.calls[1][1]).toMatchObject({
      height: 32,
      name: 'image_2.png',
      width: 64,
    });

    const [body] = (client.streamConversation as any).mock.calls[0];
    expect(body.messages[0].content.content_type).toBe('multimodal_text');
    expect(body.messages[0].content.parts).toEqual([
      expect.objectContaining({ asset_pointer: 'file-service://file-image_1.jpg' }),
      expect.objectContaining({ asset_pointer: 'file-service://file-image_2.png' }),
      'a small red cube',
    ]);
    expect(body.messages[0].metadata.attachments).toHaveLength(2);
  });

  it('caps reference images at four', async () => {
    const client = createClient({
      getConversation: vi.fn(async () => ({
        mapping: { node: toolNode('file-service://file_000000001111222233334444') },
      })),
    });

    await generate(client, {
      imageUrls: Array.from(
        { length: 6 },
        () => `data:image/png;base64,${bytesToBase64(png(8, 8))}`,
      ),
    });

    expect(client.uploadFile).toHaveBeenCalledTimes(4);
  });

  it('falls back to polling when the stream ends without a pointer', async () => {
    const getConversation = vi
      .fn()
      .mockResolvedValueOnce({ mapping: {} })
      .mockResolvedValue({ mapping: { node: toolNode('sediment://file_abc') } });

    const client = createClient({
      getConversation,
      streamConversation: vi.fn(() =>
        streamOf(
          [
            { conversationId: 'conv-1', type: 'conversation.start' },
            { toolInvoked: true, turnUseCase: 'image gen', type: 'metadata' },
          ] as ConversationEvent[],
          new ChatGPTWebError('timeout', 'stream exceeded the hard cap'),
        ),
      ),
    });

    const result = await generate(client);

    expect(getConversation).toHaveBeenCalledTimes(2);
    expect(client.getAttachmentDownloadUrl).toHaveBeenCalledWith(
      'conv-1',
      'file_abc',
      expect.anything(),
    );
    expect(result.imageUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('maps a moderation block to a content policy error', async () => {
    const client = createClient({
      listTasks: vi.fn(async () => [
        {
          image_gen_message: {
            content: { content_type: 'text', parts: ['This request was rejected.'] },
            metadata: { is_error: true },
          },
        },
      ]),
      streamConversation: vi.fn(() =>
        streamOf([
          { conversationId: 'conv-1', type: 'conversation.start' },
          { blocked: true, type: 'moderation' },
          { conversationId: 'conv-1', type: 'done' },
        ] as ConversationEvent[]),
      ),
    });

    await expect(generate(client)).rejects.toMatchObject({
      error: { message: 'This request was rejected.' },
      errorType: AgentRuntimeErrorType.ProviderContentPolicyViolation,
      provider: 'chatgptweb',
    });
  });

  it('reports the assistant refusal when no image is produced', async () => {
    const client = createClient({
      streamConversation: vi.fn(() =>
        streamOf([
          { conversationId: 'conv-1', type: 'conversation.start' },
          { delta: 'I cannot draw that.', text: 'I cannot draw that.', type: 'text.delta' },
          { conversationId: 'conv-1', type: 'done' },
        ] as ConversationEvent[]),
      ),
    });

    await expect(generate(client)).rejects.toMatchObject({
      error: { message: 'I cannot draw that.' },
      errorType: AgentRuntimeErrorType.ProviderNoImageGenerated,
    });
  });

  it('rejects models other than gpt-image-2 without any network call', async () => {
    const client = createClient();

    await expect(
      createChatGPTWebImage(
        { model: 'gpt-image-1', params: { prompt: 'x' } as any },
        { client, provider: 'chatgptweb' },
      ),
    ).rejects.toMatchObject({ errorType: AgentRuntimeErrorType.ModelNotFound });
    expect(client.getChatRequirements).not.toHaveBeenCalled();
  });

  it('surfaces an expired authorization as an invalid key', async () => {
    const client = createClient({
      getChatRequirements: vi.fn(async () => {
        throw new ChatGPTWebError('auth', 'sentinel_finalize failed: status=401 (unauthorized)', {
          status: 401,
        });
      }),
    });

    await expect(generate(client)).rejects.toMatchObject({
      // the upstream wording leaks a status/path, so it must be replaced
      error: { message: 'The image generation request failed. Please try again later.' },
      errorType: AgentRuntimeErrorType.InvalidProviderAPIKey,
    });
  });

  it('retries the requirements handshake once after a Cloudflare challenge', async () => {
    const getChatRequirements = vi
      .fn()
      .mockRejectedValueOnce(new ChatGPTWebError('cloudflare', 'blocked'))
      .mockResolvedValue({ proofToken: '', soToken: '', token: 't', turnstileToken: '' });

    const client = createClient({
      getChatRequirements,
      getConversation: vi.fn(async () => ({
        mapping: { node: toolNode('file-service://file_000000001111222233334444') },
      })),
    });

    await generate(client);
    expect(getChatRequirements).toHaveBeenCalledTimes(2);
  });

  it('returns a single image when the same bytes are reachable through two pointers', async () => {
    const client = createClient({
      getConversation: vi.fn(async () => ({
        mapping: {
          a: toolNode('file-service://file_000000001111222233334444', 1),
          b: toolNode('sediment://file_000000001111222233334444', 2),
        },
      })),
    });

    const result = await generate(client);

    expect(client.downloadBytes).toHaveBeenCalledTimes(2);
    expect(result.imageUrl).toBe(`data:image/png;base64,${bytesToBase64(RESULT_PNG)}`);
  });

  it('ignores stream events it does not know, such as a future handoff', async () => {
    const client = createClient({
      getConversation: vi.fn(async () => ({
        mapping: { node: toolNode('file-service://file_000000001111222233334444') },
      })),
      streamConversation: vi.fn(() =>
        streamOf([
          { conversationId: 'conv-1', type: 'conversation.start' },
          // shapes this switch has never seen must fall through the default arm
          { target: 'gpt-5-5-thinking', type: 'handoff' },
          { type: 'something.invented.later' },
          {
            assetPointer: 'file-service://file_000000001111222233334444',
            fileId: 'file_000000001111222233334444',
            pointerKind: 'file-service',
            type: 'image.pointer',
          },
          { conversationId: 'conv-1', endTurn: true, type: 'done' },
        ] as unknown as ConversationEvent[]),
      ),
    });

    await expect(generate(client)).resolves.toMatchObject({ height: 1024, width: 1024 });
  });

  // ------------------------------------------------------------ whole-call budget

  describe('whole-call deadline', () => {
    it('aborts a stalled phase and reports a timeout the async router maps to TaskTimeout', async () => {
      let observed: AbortSignal | undefined;
      const client = createClient({
        // never resolves on its own: only the whole-call budget can end it
        getChatRequirements: vi.fn(
          ({ signal }: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              observed = signal;
              signal.addEventListener('abort', () => reject(signal.reason));
            }),
        ),
      });

      const error = await generate(client).catch((reason) => reason);

      expect(observed).toBeInstanceOf(AbortSignal);
      expect(error.errorType).toBe(AgentRuntimeErrorType.ProviderNetworkError);
      // imageError.ts only reaches TaskTimeout through the TOP-LEVEL message
      expect(error.message).toContain('timeout');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('threads one signal through every phase', async () => {
      const client = createClient({
        getConversation: vi.fn(async () => ({
          mapping: { node: toolNode('file-service://file_000000001111222233334444') },
        })),
      });

      await generate(client, { imageUrls: [`data:image/png;base64,${bytesToBase64(png(8, 8))}`] });

      const signal = (client.uploadFile as any).mock.calls[0][2].signal as AbortSignal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect((client.getChatRequirements as any).mock.calls[0][0].signal).toBe(signal);
      expect((client.prepareConversation as any).mock.calls[0][1].signal).toBe(signal);
      expect((client.streamConversation as any).mock.calls[0][1].signal).toBe(signal);
      expect((client.getConversation as any).mock.calls[0][1]).toBe(signal);
      expect((client.downloadBytes as any).mock.calls[0][1].signal).toBe(signal);
    });

    it('reports a budget abort during a reference fetch as a timeout, not a provider error', async () => {
      // the fetch only ends when a signal fires
      vi.mocked(ssrfSafeFetch).mockImplementation(((_url: string, init: RequestInit) =>
        untilAborted(init.signal as AbortSignal)) as unknown as typeof ssrfSafeFetch);

      const client = createClient({
        // the first reference eats nearly the whole budget, so the second one's
        // own 30s cap is clamped below it and the BUDGET is what fires
        uploadFile: vi.fn(async (bytes: Uint8Array, meta: any) => {
          await after(185_000);
          return {
            fileId: `file-${meta.name}`,
            kind: 'image',
            name: meta.name,
            size: bytes.length,
          };
        }),
      });

      const error = await generate(client, {
        imageUrls: [`data:image/png;base64,${bytesToBase64(png(8, 8))}`, SIGNED_REFERENCE_URL],
      }).catch((reason) => reason);

      expect(error.errorType).toBe(AgentRuntimeErrorType.ProviderNetworkError);
      // imageError.ts only reaches TaskTimeout through the TOP-LEVEL message
      expect(error.message).toContain('timeout');
      expect(JSON.stringify(error)).not.toContain('SUPER_SECRET_SIGNATURE');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('reports a budget abort during the result download as a timeout, not as "no image"', async () => {
      const client = createClient({
        downloadBytes: vi.fn((_url: string, { signal }: { signal: AbortSignal }) =>
          untilAborted(signal),
        ),
        getConversation: vi.fn(async () => ({
          mapping: { node: toolNode('file-service://file_000000001111222233334444') },
        })),
      });

      const error = await generate(client).catch((reason) => reason);

      expect(error.errorType).toBe(AgentRuntimeErrorType.ProviderNetworkError);
      expect(error.message).toContain('timeout');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('surfaces a 401 raised while resolving the result as an auth failure', async () => {
      const client = createClient({
        getConversation: vi.fn(async () => ({
          mapping: { node: toolNode('file-service://file_000000001111222233334444') },
        })),
        getFileDownloadUrl: vi.fn(async () => {
          throw new ChatGPTWebError('auth', 'file download url failed: status=401 (unauthorized)', {
            status: 401,
          });
        }),
      });

      const error = await generate(client).catch((reason) => reason);

      // a dead token must never read as "the model declined to draw"
      expect(error.errorType).toBe(AgentRuntimeErrorType.InvalidProviderAPIKey);
      expect(client.downloadBytes).not.toHaveBeenCalled();
    });

    it('never lets the cosmetic cleanup run past the budget', async () => {
      const client = createClient({
        // returns with ~3s of budget left
        downloadBytes: vi.fn(async () => {
          await after(197_000);
          return { bytes: RESULT_PNG, mimeType: 'image/png' };
        }),
        getConversation: vi.fn(async () => ({
          mapping: { node: toolNode('file-service://file_000000001111222233334444') },
        })),
        hideConversation: vi.fn((_id: string, signal: AbortSignal) => untilAborted(signal)),
      });
      const startedAt = Date.now();

      const result = await generate(client);

      expect(result.width).toBe(1024);
      expect(client.hideConversation).toHaveBeenCalled();
      // an independent 5s cleanup deadline would land at 202s
      expect(Date.now() - startedAt).toBeLessThanOrEqual(200_000);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('skips the cleanup entirely once the budget is spent', async () => {
      const client = createClient({
        downloadBytes: vi.fn(async () => {
          await after(205_000);
          return { bytes: RESULT_PNG, mimeType: 'image/png' };
        }),
        getConversation: vi.fn(async () => ({
          mapping: { node: toolNode('file-service://file_000000001111222233334444') },
        })),
      });

      const result = await generate(client);

      expect(result.width).toBe(1024);
      expect(client.hideConversation).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('reports a poll that ran out of budget as a timeout, not as "no image"', async () => {
      const client = createClient({
        // the task never materialises a pointer
        getConversation: vi.fn(async () => ({ mapping: {} })),
        streamConversation: vi.fn(() =>
          streamOf([
            { conversationId: 'conv-1', type: 'conversation.start' },
            { toolInvoked: true, turnUseCase: 'image gen', type: 'metadata' },
            { conversationId: 'conv-1', type: 'done' },
          ] as ConversationEvent[]),
        ),
      });

      const error = await generate(client).catch((reason) => reason);

      expect(error.errorType).toBe(AgentRuntimeErrorType.ProviderNetworkError);
      expect(error.message).toContain('timeout');
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // ------------------------------------------------------- text-only classification

  describe('text-only turns', () => {
    const textOnlyClient = (extra: Partial<Record<string, any>> = {}) =>
      createClient({
        streamConversation: vi.fn(() =>
          streamOf([
            { conversationId: 'conv-1', type: 'conversation.start' },
            { toolInvoked: false, turnUseCase: 'multimodal', type: 'metadata' },
            { delta: 'Here is a description.', text: 'Here is a description.', type: 'text.delta' },
            { conversationId: 'conv-1', type: 'done' },
          ] as ConversationEvent[]),
        ),
        ...extra,
      });

    it('fails immediately instead of polling for a task that does not exist', async () => {
      const client = textOnlyClient();
      const startedAt = Date.now();

      await expect(generate(client)).rejects.toMatchObject({
        error: { message: 'Here is a description.' },
        errorType: AgentRuntimeErrorType.ProviderNoImageGenerated,
      });

      expect(client.getConversation).not.toHaveBeenCalled();
      // nowhere near the 10s initial poll wait, let alone the 200s budget
      expect(Date.now() - startedAt).toBeLessThanOrEqual(2000);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('still polls an edit, whose tool metadata is unreliable', async () => {
      const client = textOnlyClient({
        getConversation: vi.fn(async () => ({
          mapping: { node: toolNode('file-service://file_000000001111222233334444') },
        })),
      });

      const result = await generate(client, {
        imageUrls: [`data:image/png;base64,${bytesToBase64(png(8, 8))}`],
      });

      expect(client.getConversation).toHaveBeenCalled();
      expect(result.imageUrl.startsWith('data:image/png;base64,')).toBe(true);
    });

    it('still polls when the turn declared an image use case', async () => {
      const client = createClient({
        getConversation: vi.fn(async () => ({
          mapping: { node: toolNode('file-service://file_000000001111222233334444') },
        })),
        streamConversation: vi.fn(() =>
          streamOf([
            { conversationId: 'conv-1', type: 'conversation.start' },
            { toolInvoked: false, turnUseCase: 'image_gen', type: 'metadata' },
            { conversationId: 'conv-1', type: 'done' },
          ] as ConversationEvent[]),
        ),
      });

      await expect(generate(client)).resolves.toMatchObject({ width: 1024 });
    });

    it('still polls when the turn sent no tool metadata at all', async () => {
      const client = createClient({
        getConversation: vi.fn(async () => ({
          mapping: { node: toolNode('file-service://file_000000001111222233334444') },
        })),
        streamConversation: vi.fn(() =>
          streamOf([
            { conversationId: 'conv-1', type: 'conversation.start' },
            { conversationId: 'conv-1', type: 'done' },
          ] as ConversationEvent[]),
        ),
      });

      await expect(generate(client)).resolves.toMatchObject({ width: 1024 });
    });
  });

  // ------------------------------------------------------------ reference limits

  describe('reference ingestion', () => {
    it('rejects an oversized data URI before decoding it', async () => {
      const client = createClient();
      // 4/3 of the limit in characters — decoding this would allocate >10 MiB
      const oversized = 'A'.repeat(Math.ceil(((MAX_REFERENCE_BYTES + 1) * 4) / 3));

      await expect(
        generate(client, { imageUrls: [`data:image/png;base64,${oversized}`] }),
      ).rejects.toMatchObject({
        error: { message: expect.stringContaining('exceeds') },
      });
      expect(client.uploadFile).not.toHaveBeenCalled();
    });

    it('accepts a data URI right under the limit', async () => {
      const client = createClient({
        getConversation: vi.fn(async () => ({
          mapping: { node: toolNode('file-service://file_000000001111222233334444') },
        })),
      });
      // 4 base64 characters decode to 3 bytes: the largest whole triple that
      // still fits under the cap
      const triples = Math.floor(MAX_REFERENCE_BYTES / 3);
      const nearLimit = 'A'.repeat(triples * 4);

      await generate(client, { imageUrls: [`data:image/png;base64,${nearLimit}`] });

      expect(client.uploadFile).toHaveBeenCalledTimes(1);
      expect((client.uploadFile as any).mock.calls[0][0].length).toBe(triples * 3);
    });

    it('accepts a padded data URI of exactly the limit and rejects one byte more', async () => {
      const client = createClient({
        getConversation: vi.fn(async () => ({
          mapping: { node: toolNode('file-service://file_000000001111222233334444') },
        })),
      });

      // 10 MiB is 1 mod 3, so the padded encoding is two bytes longer than the
      // payload — counting the `=` as data would reject a legal reference
      await generate(client, {
        imageUrls: [`data:image/png;base64,${paddedBase64(MAX_REFERENCE_BYTES)}`],
      });

      expect((client.uploadFile as any).mock.calls[0][0].length).toBe(MAX_REFERENCE_BYTES);

      const over = createClient();
      await expect(
        generate(over, {
          imageUrls: [`data:image/png;base64,${paddedBase64(MAX_REFERENCE_BYTES + 1)}`],
        }),
      ).rejects.toMatchObject({ error: { message: expect.stringContaining('exceeds') } });
      expect(over.uploadFile).not.toHaveBeenCalled();
    });

    it('treats an empty imageUrls plus a legacy imageUrl as an edit', async () => {
      const client = createClient({
        getConversation: vi.fn(async () => ({
          mapping: { node: toolNode('file-service://file_000000001111222233334444') },
        })),
      });

      // model defaults routinely ship `imageUrls: []`; it must not swallow the
      // single-image field and silently downgrade an edit to a generation
      await generate(client, {
        imageUrl: `data:image/png;base64,${bytesToBase64(png(8, 8))}`,
        imageUrls: [],
      });

      expect(client.uploadFile).toHaveBeenCalledTimes(1);
      const [body] = (client.streamConversation as any).mock.calls[0];
      expect(body.messages[0].content.content_type).toBe('multimodal_text');
      expect(body.messages[0].metadata.attachments).toHaveLength(1);
    });

    it('keeps the signed reference URL out of the console on failure', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      // node-fetch bakes the request URL into its message; ssrf-safe-fetch then
      // console.errors that raw error. THAT leak lives in the shared package
      // (see the TODO in createImage.ts) and is mocked away here — what this
      // asserts is that the chatgptWeb pipeline never adds one of its own.
      vi.mocked(ssrfSafeFetch).mockRejectedValue(
        new Error(`request to ${SIGNED_REFERENCE_URL} failed, reason: socket hang up`),
      );
      const client = createClient();

      const error = await generate(client, { imageUrls: [SIGNED_REFERENCE_URL] }).catch(
        (reason) => reason,
      );

      const logged = consoleError.mock.calls.flat().map(String).join(' ');
      expect(logged).not.toContain('SUPER_SECRET_SIGNATURE');
      expect(error.error.message).toBe('the reference image at blob.example.com could not be read');
      expect(JSON.stringify(error)).not.toContain('SUPER_SECRET_SIGNATURE');
      consoleError.mockRestore();
    });

    it('stops an http reference at the byte cap and never leaks the signed URL', async () => {
      vi.mocked(ssrfSafeFetch).mockResolvedValue(streamedResponse(MAX_REFERENCE_BYTES + 1));
      const client = createClient();

      const error = await generate(client, { imageUrls: [SIGNED_REFERENCE_URL] }).catch(
        (reason) => reason,
      );

      expect(error.error.message).toContain('blob.example.com');
      expect(JSON.stringify(error)).not.toContain('SUPER_SECRET_SIGNATURE');
      expect(client.uploadFile).not.toHaveBeenCalled();
    });

    it('rejects a non-2xx reference response by host, not by URL', async () => {
      vi.mocked(ssrfSafeFetch).mockResolvedValue(new Response('nope', { status: 403 }));
      const client = createClient();

      const error = await generate(client, { imageUrls: [SIGNED_REFERENCE_URL] }).catch(
        (reason) => reason,
      );

      expect(error.error.message).toBe('the reference image at blob.example.com could not be read');
      expect(JSON.stringify(error)).not.toContain('sig=');
    });

    it('caps the reference fetch with the whole-call signal', async () => {
      vi.mocked(ssrfSafeFetch).mockResolvedValue(
        new Response(asBody(png(4, 4)), { headers: { 'content-type': 'image/png' } }),
      );
      const client = createClient({
        getConversation: vi.fn(async () => ({
          mapping: { node: toolNode('file-service://file_000000001111222233334444') },
        })),
      });

      await generate(client, { imageUrls: ['https://example.com/ref.png'] });

      const [, init, ssrfOptions] = vi.mocked(ssrfSafeFetch).mock.calls[0];
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
      expect(ssrfOptions).toEqual({ maxContentLength: MAX_REFERENCE_BYTES + 1 });
    });
  });

  // -------------------------------------------------------------- result checks

  it('refuses a "successful" download whose bytes are not an image', async () => {
    const client = createClient({
      downloadBytes: vi.fn(async () => ({
        bytes: new TextEncoder().encode('<!doctype html><html>error</html>'),
        mimeType: 'text/html',
      })),
      getConversation: vi.fn(async () => ({
        mapping: { node: toolNode('file-service://file_000000001111222233334444') },
      })),
    });

    await expect(generate(client)).rejects.toMatchObject({
      errorType: AgentRuntimeErrorType.ProviderNoImageGenerated,
    });
  });

  it('skips an unusable pointer and returns the next valid one', async () => {
    const client = createClient({
      downloadBytes: vi
        .fn()
        .mockResolvedValueOnce({ bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) })
        .mockResolvedValue({ bytes: RESULT_PNG, mimeType: 'image/png' }),
      getConversation: vi.fn(async () => ({
        mapping: {
          a: toolNode('file-service://file_000000001111222233334444', 1),
          b: toolNode('sediment://file_000000005555666677778888', 2),
        },
      })),
    });

    const result = await generate(client);

    expect(result.imageUrl).toBe(`data:image/png;base64,${bytesToBase64(RESULT_PNG)}`);
  });
});

describe('result serialization', () => {
  // 32 MiB of real encode/decode work: slower than the 5s default under a
  // parallel suite, which is the point of the test
  it('encodes a download of the full 32 MiB ceiling', { timeout: 60_000 }, () => {
    // the result is returned as one `data:` URL, so the largest body the client
    // will accept has to survive `bytesToBase64` — an implementation built on
    // `String.fromCharCode.apply` blows the argument limit long before this
    const size = 32 * 1024 * 1024;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = i & 0xff;

    const encoded = bytesToBase64(bytes);
    expect(encoded).toHaveLength(Math.ceil(size / 3) * 4);

    const decoded = base64ToBytes(encoded);
    expect(decoded).toHaveLength(size);
    for (const index of [0, 1, 255, 256, size - 2, size - 1])
      expect(decoded[index]).toBe(index & 0xff);
  });
});
