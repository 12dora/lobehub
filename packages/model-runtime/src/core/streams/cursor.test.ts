import { describe, expect, it } from 'vitest';

import { CursorStream, iterateReadable } from './cursor';

const encoder = new TextEncoder();

/** Verbatim events from explore/cursor-sandbox/print-stream.jsonl */
const PRINT_STREAM_EVENTS = [
  {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'login',
    cwd: '/private/tmp/claude-501/-Users-konata-code-AIHub/fec8a0bc-9ddf-4584-bd2d-67d2cc038eda/scratchpad/mb/explore/cursor-sandbox',
    session_id: 'e22f36ab-002e-4067-8a49-f6b5ccc38b24',
    model: 'Composer 2.5',
    permissionMode: 'default',
  },
  {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'Reply with the single word pong' }] },
    session_id: 'e22f36ab-002e-4067-8a49-f6b5ccc38b24',
  },
  {
    type: 'thinking',
    subtype: 'delta',
    text: 'The user requested a',
    session_id: 'e22f36ab-002e-4067-8a49-f6b5ccc38b24',
    timestamp_ms: 1_786_975_512_483,
  },
  {
    type: 'thinking',
    subtype: 'delta',
    text: ' single-word reply: ',
    session_id: 'e22f36ab-002e-4067-8a49-f6b5ccc38b24',
    timestamp_ms: 1_786_975_512_484,
  },
  {
    type: 'thinking',
    subtype: 'delta',
    text: '"pong". This appears',
    session_id: 'e22f36ab-002e-4067-8a49-f6b5ccc38b24',
    timestamp_ms: 1_786_975_512_484,
  },
  {
    type: 'thinking',
    subtype: 'delta',
    text: ' to be a simple ping-pong',
    session_id: 'e22f36ab-002e-4067-8a49-f6b5ccc38b24',
    timestamp_ms: 1_786_975_512_484,
  },
  {
    type: 'thinking',
    subtype: 'delta',
    text: ' test.',
    session_id: 'e22f36ab-002e-4067-8a49-f6b5ccc38b24',
    timestamp_ms: 1_786_975_512_484,
  },
  {
    type: 'thinking',
    subtype: 'completed',
    session_id: 'e22f36ab-002e-4067-8a49-f6b5ccc38b24',
    timestamp_ms: 1_786_975_512_484,
  },
  {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }] },
    session_id: 'e22f36ab-002e-4067-8a49-f6b5ccc38b24',
  },
  {
    type: 'result',
    subtype: 'success',
    duration_ms: 5398,
    duration_api_ms: 5398,
    is_error: false,
    result: 'pong',
    session_id: 'e22f36ab-002e-4067-8a49-f6b5ccc38b24',
    request_id: 'e330e9a0-d4b2-4a42-81f5-fa473c027e92',
    usage: { inputTokens: 7175, outputTokens: 39, cacheReadTokens: 6048, cacheWriteTokens: 0 },
  },
];

const toSse = (events: object[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

const collect = async (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream as any) text += decoder.decode(chunk, { stream: true });
  return text;
};

const eventTypes = (raw: string) =>
  raw
    .split('\n')
    .filter((line) => line.startsWith('event: '))
    .map((line) => line.slice('event: '.length));

describe('CursorStream', () => {
  it('maps the print-stream.jsonl sample into reasoning, text, usage, stop', async () => {
    const raw = await collect(CursorStream(toSse(PRINT_STREAM_EVENTS)));

    expect(eventTypes(raw)).toEqual([
      'reasoning',
      'reasoning',
      'reasoning',
      'reasoning',
      'reasoning',
      'text',
      'usage',
      'stop',
    ]);
    expect(raw).toContain('The user requested a');
    expect(raw).toContain(' test.');
    expect(raw).toContain('data: "pong"');
    expect(raw.match(/data: "pong"/g)).toHaveLength(1);
    expect(raw).toContain('"inputCachedTokens":6048');
    expect(raw).toContain('"totalInputTokens":7175');
    expect(raw).toContain('"totalOutputTokens":39');
    expect(raw).toContain('"totalTokens":7214');
    expect(raw).toContain('event: stop\ndata: "stop"');
  });

  it('streams assistant fragments and ignores the final full-text replay', async () => {
    const raw = await collect(
      CursorStream(
        toSse([
          { type: 'thinking', subtype: 'delta', text: 'hmm' },
          { type: 'thinking', subtype: 'completed' },
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'po' }] },
          },
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'ng' }] },
          },
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }] },
          },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'pong',
            usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 },
          },
        ]),
      ),
    );

    expect(eventTypes(raw)).toEqual(['reasoning', 'text', 'text', 'usage', 'stop']);
    expect(raw).toContain('data: "po"');
    expect(raw).toContain('data: "ng"');
    expect(raw).not.toContain('data: "pong"');
    expect(raw).toContain('"totalTokens":12');
  });

  it('maps transport unauthorized to an OAuthAuthorizationExpired error chunk', async () => {
    const raw = await collect(
      CursorStream(
        toSse([
          {
            type: 'transport',
            subtype: 'error',
            code: 'unauthorized',
            message: 'not logged in',
          },
        ]),
      ),
    );

    expect(eventTypes(raw)).toEqual(['error', 'stop']);
    expect(raw).toContain('not logged in');
    expect(raw).toContain('OAuthAuthorizationExpired');
  });

  it('maps other transport errors to ProviderBizError', async () => {
    const raw = await collect(
      CursorStream(
        toSse([
          { type: 'transport', subtype: 'notice', message: 'images ignored' },
          {
            type: 'transport',
            subtype: 'error',
            code: 'cli_unavailable',
            message: 'cursor-agent missing',
          },
        ]),
      ),
    );

    expect(eventTypes(raw)).toEqual(['error', 'stop']);
    expect(raw).toContain('cursor-agent missing');
    expect(raw).toContain('ProviderBizError');
    expect(raw).not.toContain('images ignored');
  });

  it('maps result is_error to a ProviderBizError chunk', async () => {
    const raw = await collect(
      CursorStream(
        toSse([
          {
            type: 'result',
            subtype: 'error',
            is_error: true,
            result: 'model overloaded',
          },
        ]),
      ),
    );

    expect(eventTypes(raw)).toEqual(['error', 'stop']);
    expect(raw).toContain('model overloaded');
    expect(raw).toContain('ProviderBizError');
  });

  it('maps an auth-looking result error to OAuthAuthorizationExpired', async () => {
    const raw = await collect(
      CursorStream(
        toSse([
          {
            type: 'result',
            subtype: 'error',
            is_error: true,
            result: 'token expired: unauthenticated',
          },
        ]),
      ),
    );

    expect(eventTypes(raw)).toEqual(['error', 'stop']);
    expect(raw).toContain('token expired');
    expect(raw).toContain('OAuthAuthorizationExpired');
    expect(raw).not.toContain('ProviderBizError');
  });

  it('maps transport cli_exit (exit without a result) to ProviderBizError', async () => {
    const raw = await collect(
      CursorStream(
        toSse([
          {
            type: 'transport',
            subtype: 'error',
            code: 'cli_exit',
            message: 'CLI exited without a result',
            exitCode: 0,
          },
        ]),
      ),
    );

    expect(eventTypes(raw)).toEqual(['error', 'stop']);
    expect(raw).toContain('CLI exited without a result');
    expect(raw).toContain('ProviderBizError');
  });

  it('cancels the source reader when iteration does not finish naturally', async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    });

    const iter = iterateReadable(source);
    const first = await iter.next();
    expect(first.done).toBe(false);
    await iter.return();
    expect(cancelled).toBe(true);
  });
});
