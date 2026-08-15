// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatGPTWebClient } from './client';
import { ChatGPTWebError } from './errors';
import {
  collectPointers,
  extractDocumentPointers,
  findTaskErrorMessage,
  pollImageResults,
  retryDelayMs,
} from './imagePoll';

const toolNode = (pointer: string, createTime: number) => ({
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

describe('collectPointers', () => {
  it('harvests both pointer schemes and bare generated ids', () => {
    expect(
      collectPointers({
        parts: [
          { asset_pointer: 'file-service://file_000000001111222233334444' },
          { asset_pointer: 'sediment://file_deadbeef' },
        ],
        text: 'saved as file_000000009999888877776666aabbccdd',
      }),
    ).toEqual([
      { fileId: 'file_000000001111222233334444', kind: 'file-service' },
      { fileId: 'file_deadbeef', kind: 'sediment' },
      { fileId: 'file_000000009999888877776666aabbccdd', kind: 'file-service' },
    ]);
  });

  it('drops the upload placeholder', () => {
    expect(collectPointers({ pointer: 'sediment://file_upload' })).toEqual([]);
  });
});

describe('extractDocumentPointers', () => {
  it('orders tool records by create_time and ignores the user turn', () => {
    const pointers = extractDocumentPointers({
      mapping: {
        second: toolNode('file-service://file_000000002222222222222222', 20),
        user: {
          message: {
            author: { role: 'user' },
            content: {
              content_type: 'multimodal_text',
              parts: [{ asset_pointer: 'sediment://file_input_ref' }],
            },
            create_time: 1,
          },
        },
        first: toolNode('file-service://file_000000001111111111111111', 10),
      },
    });

    expect(pointers).toEqual([
      { fileId: 'file_000000001111111111111111', kind: 'file-service' },
      { fileId: 'file_000000002222222222222222', kind: 'file-service' },
    ]);
  });

  it('keeps assistant records only when they carry image output', () => {
    const document = {
      mapping: {
        prose: {
          message: {
            author: { role: 'assistant' },
            content: {
              content_type: 'text',
              parts: ['file-service://file_000000000000000000000000'],
            },
            create_time: 5,
          },
        },
      },
    };

    expect(extractDocumentPointers(document)).toEqual([]);
  });
});

describe('findTaskErrorMessage', () => {
  it('reads the structural error flag rather than matching prose', () => {
    expect(
      findTaskErrorMessage([
        { image_gen_message: { metadata: { is_error: false } } },
        {
          image_gen_message: {
            content: { content_type: 'text', parts: ['Blocked by policy.'] },
            metadata: { is_error: true },
          },
        },
      ]),
    ).toBe('Blocked by policy.');
  });

  it('ignores tasks that merely mention a policy', () => {
    expect(
      findTaskErrorMessage([
        {
          image_gen_message: {
            content: { content_type: 'text', parts: ['Our policy allows this.'] },
            metadata: { is_error: false },
          },
        },
      ]),
    ).toBeUndefined();
  });
});

describe('retryDelayMs', () => {
  it('honours Retry-After: 0 instead of coercing it away', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(retryDelayMs(3, 0)).toBe(0);
    expect(retryDelayMs(1, undefined)).toBe(2000);
    expect(retryDelayMs(9, undefined)).toBe(16_000);
  });
});

describe('pollImageResults', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    // a poll that returns while one of its sleeps is still armed would keep the
    // process (and, under fake timers, every later test) waiting on it
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const client = (overrides: Record<string, any>) =>
    ({
      getConversation: vi.fn(async () => ({ mapping: {} })),
      listTasks: vi.fn(async () => []),
      ...overrides,
    }) as unknown as ChatGPTWebClient & Record<string, ReturnType<typeof vi.fn>>;

  it('waits for the pointer set to settle before returning', async () => {
    const getConversation = vi
      .fn()
      .mockResolvedValueOnce({ mapping: { a: toolNode('file-service://file_one', 1) } })
      .mockResolvedValueOnce({
        mapping: {
          a: toolNode('file-service://file_one', 1),
          b: toolNode('sediment://file_two', 2),
        },
      })
      .mockResolvedValue({
        mapping: {
          a: toolNode('file-service://file_one', 1),
          b: toolNode('sediment://file_two', 2),
        },
      });

    const result = await settle(
      pollImageResults({
        checkBeforeHit: true,
        client: client({ getConversation }),
        conversationId: 'conv-1',
        deadline: Date.now() + 120_000,
      }),
    );

    expect(getConversation).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      pointers: [
        { fileId: 'file_one', kind: 'file-service' },
        { fileId: 'file_two', kind: 'sediment' },
      ],
      timedOut: false,
    });
  });

  it('returns on the first hit when check-before-hit is off', async () => {
    const getConversation = vi.fn(async () => ({
      mapping: { a: toolNode('file-service://file_one', 1) },
    }));

    const result = await settle(
      pollImageResults({
        client: client({ getConversation }),
        conversationId: 'conv-1',
        deadline: Date.now() + 120_000,
        initialPointers: [{ fileId: 'file_one', kind: 'file-service' }],
      }),
    );

    expect(getConversation).toHaveBeenCalledTimes(1);
    expect(result.timedOut).toBe(false);
  });

  it('retries a 429 and honours Retry-After: 0', async () => {
    const startedAt = Date.now();
    const getConversation = vi
      .fn()
      .mockRejectedValueOnce(
        new ChatGPTWebError('rate_limit', 'rate limited', { retryAfterMs: 0, status: 429 }),
      )
      .mockResolvedValue({ mapping: { a: toolNode('file-service://file_one', 1) } });

    const result = await settle(
      pollImageResults({
        client: client({ getConversation }),
        conversationId: 'conv-1',
        deadline: startedAt + 120_000,
        initialPointers: [{ fileId: 'file_one', kind: 'file-service' }],
      }),
    );

    expect(getConversation).toHaveBeenCalledTimes(2);
    expect(result.timedOut).toBe(false);
    // 2s settle wait + an immediate retry — no exponential backoff was applied
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it('rethrows a non-retryable failure', async () => {
    const getConversation = vi
      .fn()
      .mockRejectedValue(new ChatGPTWebError('auth', 'unauthorized', { status: 401 }));

    await expect(
      settle(
        pollImageResults({
          client: client({ getConversation }),
          conversationId: 'conv-1',
          deadline: Date.now() + 60_000,
        }),
      ),
    ).rejects.toThrow('unauthorized');
  });

  it('reports the task error and times out without spending the whole budget on the first wait', async () => {
    const listTasks = vi.fn(async () => [
      {
        image_gen_message: {
          content: { content_type: 'text', parts: ['Rejected.'] },
          metadata: { is_error: true },
        },
      },
    ]);
    const getConversation = vi.fn(async () => ({ mapping: {} }));

    const result = await settle(
      pollImageResults({
        client: client({ getConversation, listTasks }),
        conversationId: 'conv-1',
        // a 20s budget must still leave room for polls after the initial wait
        deadline: Date.now() + 20_000,
      }),
    );

    expect(getConversation).toHaveBeenCalled();
    expect(result).toEqual({ pointers: [], taskErrorMessage: 'Rejected.', timedOut: true });
  });

  it('does nothing once the deadline has passed', async () => {
    const getConversation = vi.fn();

    const result = await settle(
      pollImageResults({
        client: client({ getConversation }),
        conversationId: 'conv-1',
        deadline: Date.now(),
      }),
    );

    expect(getConversation).not.toHaveBeenCalled();
    expect(result.timedOut).toBe(true);
  });
});
