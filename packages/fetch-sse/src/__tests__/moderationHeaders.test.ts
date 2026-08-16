import type { FetchEventSourceInit } from '@lobechat/utils/client/fetchEventSource/index';
import { fetchEventSource } from '@lobechat/utils/client/fetchEventSource/index';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MODERATION_HEADERS } from '@/const/platform/contentModeration';

import { fetchSSE, parseModerationHeaders } from '../fetchSSE';

vi.mock('i18next', () => ({
  t: vi.fn((key) => `translated_${key}`),
}));

vi.mock('@lobechat/utils/client/fetchEventSource/index', () => ({
  fetchEventSource: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const downgradeHeaders = (extra: Record<string, string> = {}) =>
  new Headers({
    [MODERATION_HEADERS.ACTION]: 'downgrade',
    [MODERATION_HEADERS.MODEL]: 'safe-model',
    [MODERATION_HEADERS.PROVIDER]: 'safe-provider',
    ...extra,
  });

describe('parseModerationHeaders', () => {
  it('decodes a full downgrade header set', () => {
    const result = parseModerationHeaders(
      downgradeHeaders({
        [MODERATION_HEADERS.CATEGORY]: 'jailbreak',
        [MODERATION_HEADERS.MESSAGE]: encodeURIComponent('本次回复已改用 {{model}}'),
        [MODERATION_HEADERS.RECORD]: 'record-1',
      }),
      { model: 'gpt-4o', provider: 'openai' },
    );

    expect(result).toEqual({
      action: 'downgrade',
      category: 'jailbreak',
      message: '本次回复已改用 {{model}}',
      model: 'safe-model',
      originalModel: 'gpt-4o',
      originalProvider: 'openai',
      provider: 'safe-provider',
      recordId: 'record-1',
    });
  });

  it('drops a malformed percent-escape in the admin message instead of throwing', () => {
    // A lone `%` is not a valid escape — `decodeURIComponent` throws URIError.
    const result = parseModerationHeaders(
      downgradeHeaders({ [MODERATION_HEADERS.MESSAGE]: '100% safe %E0%A4%A' }),
    );

    expect(result).toMatchObject({ message: undefined, model: 'safe-model' });
  });

  it('leaves the admin message absent when the header is missing or empty', () => {
    expect(parseModerationHeaders(downgradeHeaders())).toMatchObject({ message: undefined });
    expect(
      parseModerationHeaders(downgradeHeaders({ [MODERATION_HEADERS.MESSAGE]: '' })),
    ).toMatchObject({ message: undefined });
  });

  it('returns undefined when the action header is absent or not a downgrade', () => {
    expect(parseModerationHeaders(new Headers())).toBeUndefined();
    expect(
      parseModerationHeaders(new Headers({ [MODERATION_HEADERS.ACTION]: 'block' })),
    ).toBeUndefined();
  });

  it('returns undefined when the effective model is missing or blank', () => {
    expect(
      parseModerationHeaders(new Headers({ [MODERATION_HEADERS.ACTION]: 'downgrade' })),
    ).toBeUndefined();
    expect(
      parseModerationHeaders(
        new Headers({
          [MODERATION_HEADERS.ACTION]: 'downgrade',
          [MODERATION_HEADERS.MODEL]: '   ',
          [MODERATION_HEADERS.PROVIDER]: 'safe-provider',
        }),
      ),
    ).toBeUndefined();
  });

  it('falls back to the request provider when the runtime stays inside the same provider', () => {
    const result = parseModerationHeaders(
      new Headers({
        [MODERATION_HEADERS.ACTION]: 'downgrade',
        [MODERATION_HEADERS.MODEL]: 'safe-model',
      }),
      { model: 'gpt-4o', provider: 'openai' },
    );

    expect(result).toMatchObject({ originalProvider: 'openai', provider: 'openai' });
  });

  it('falls back to the effective model when no request context is available', () => {
    expect(parseModerationHeaders(downgradeHeaders())).toMatchObject({
      originalModel: 'safe-model',
      originalProvider: 'safe-provider',
    });
  });

  it('drops empty optional headers instead of persisting blank strings', () => {
    expect(
      parseModerationHeaders(
        downgradeHeaders({ [MODERATION_HEADERS.CATEGORY]: '', [MODERATION_HEADERS.RECORD]: '  ' }),
      ),
    ).toMatchObject({ category: undefined, recordId: undefined });
  });
});

describe('fetchSSE moderation headers', () => {
  it('passes the decoded moderation metadata to onFinish', async () => {
    const onFinish = vi.fn();

    (fetchEventSource as any).mockImplementationOnce(
      (_url: string, options: FetchEventSourceInit) => {
        options.onopen!({
          clone: () => ({
            ok: true,
            headers: downgradeHeaders({ [MODERATION_HEADERS.CATEGORY]: 'sexual' }),
          }),
        } as any);
        options.onmessage!({ event: 'text', data: JSON.stringify('Hi') } as any);
      },
    );

    await fetchSSE('/', {
      onFinish,
      onMessageHandle: vi.fn(),
      requestContext: { model: 'gpt-4o', provider: 'openai' },
    });

    expect(onFinish).toHaveBeenCalledWith(
      'Hi',
      expect.objectContaining({
        moderation: {
          action: 'downgrade',
          category: 'sexual',
          model: 'safe-model',
          originalModel: 'gpt-4o',
          originalProvider: 'openai',
          provider: 'safe-provider',
          recordId: undefined,
        },
      }),
    );
  });

  it('omits moderation metadata for an ordinary response', async () => {
    const onFinish = vi.fn();

    (fetchEventSource as any).mockImplementationOnce(
      (_url: string, options: FetchEventSourceInit) => {
        options.onopen!({ clone: () => ({ ok: true, headers: new Headers() }) } as any);
        options.onmessage!({ event: 'text', data: JSON.stringify('Hi') } as any);
      },
    );

    await fetchSSE('/', { onFinish, onMessageHandle: vi.fn() });

    expect(onFinish).toHaveBeenCalledWith('Hi', expect.objectContaining({ moderation: undefined }));
  });
});
