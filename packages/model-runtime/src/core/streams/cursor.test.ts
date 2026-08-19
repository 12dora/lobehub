import { describe, expect, it } from 'vitest';

import {
  CURSOR_TOOL_CALLS_CLOSE,
  CURSOR_TOOL_CALLS_OPEN,
} from '../../providers/cursor/toolProtocol';
import { CursorStream, iterateReadable, transformCursorEvents } from './cursor';
import type { StreamProtocolChunk } from './protocol';

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

  it('emits tool_calls SSE and a tool_calls stop reason', async () => {
    const block = `${CURSOR_TOOL_CALLS_OPEN}\n${JSON.stringify([{ name: 'search', arguments: { q: 'pong' } }])}\n${CURSOR_TOOL_CALLS_CLOSE}`;
    const raw = await collect(
      CursorStream(
        toSse([
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: `ok\n${block}` }] },
          },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: `ok\n${block}`,
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
          },
        ]),
        { parseToolCalls: true },
      ),
    );

    expect(eventTypes(raw)).toEqual(['text', 'tool_calls', 'usage', 'stop']);
    expect(raw).toContain('data: "ok\\n"');
    expect(raw).not.toContain('aihub:tool_calls');
    expect(raw).toContain('"name":"search"');
    expect(raw).toContain('event: stop\ndata: "tool_calls"');
  });

  it('passes a marker-literal through when parseToolCalls is omitted', async () => {
    const block = `${CURSOR_TOOL_CALLS_OPEN}\n${JSON.stringify([{ name: 'search', arguments: { q: 'pong' } }])}\n${CURSOR_TOOL_CALLS_CLOSE}`;
    const raw = await collect(
      CursorStream(
        toSse([
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: block }] },
          },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: block,
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
          },
        ]),
      ),
    );

    expect(eventTypes(raw)).toEqual(['text', 'usage', 'stop']);
    expect(raw).toContain('aihub:tool_calls');
    expect(raw).not.toContain('event: tool_calls');
    expect(raw).toContain('event: stop\ndata: "stop"');
  });
});

const TOOL_CALL_ID = 'chat_tool_test';

const SEARCH_BLOCK = `${CURSOR_TOOL_CALLS_OPEN}\n${JSON.stringify([{ name: 'search', arguments: { q: 'pong' } }])}\n${CURSOR_TOOL_CALLS_CLOSE}`;

const PARALLEL_BLOCK = `${CURSOR_TOOL_CALLS_OPEN}\n${JSON.stringify([
  { name: 'search', arguments: { q: 'pong' } },
  { name: 'weather', arguments: { city: 'NYC' } },
])}\n${CURSOR_TOOL_CALLS_CLOSE}`;

async function* eventsOf(
  events: object[],
): AsyncGenerator<(typeof events)[number] & { type?: string }, void, undefined> {
  for (const event of events) yield event;
}

const collectChunks = async (
  events: object[],
  options: { parseToolCalls?: boolean } = { parseToolCalls: true },
): Promise<StreamProtocolChunk[]> => {
  const chunks: StreamProtocolChunk[] = [];
  for await (const chunk of transformCursorEvents(eventsOf(events), {
    parseToolCalls: options.parseToolCalls,
    streamStack: { id: TOOL_CALL_ID },
  })) {
    chunks.push(chunk);
  }
  return chunks;
};

const joinedText = (chunks: StreamProtocolChunk[]) =>
  chunks
    .filter((chunk) => chunk.type === 'text')
    .map((chunk) => chunk.data)
    .join('');

const assistant = (text: string) => ({
  message: { content: [{ text, type: 'text' }], role: 'assistant' },
  type: 'assistant',
});

const successResult = (result: string) => ({
  is_error: false,
  result,
  subtype: 'success',
  type: 'result',
  usage: { cacheReadTokens: 0, inputTokens: 1, outputTokens: 1 },
});

const toolCallId = (name: string, index: number) =>
  expect.stringMatching(new RegExp(`^${name}_${index}_[0-9a-zA-Z]{8}$`));

describe('transformCursorEvents tool-call emulation', () => {
  it('parses a marker that arrives in one chunk', async () => {
    const chunks = await collectChunks([assistant(SEARCH_BLOCK), successResult(SEARCH_BLOCK)]);

    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([]);
    expect(chunks.filter((chunk) => chunk.type === 'tool_calls')).toEqual([
      {
        data: [
          {
            function: { arguments: '{"q":"pong"}', name: 'search' },
            id: toolCallId('search', 0),
            index: 0,
            type: 'function',
          },
        ],
        id: TOOL_CALL_ID,
        type: 'tool_calls',
      },
    ]);
    expect(chunks.at(-1)).toEqual({ data: 'tool_calls', id: TOOL_CALL_ID, type: 'stop' });
  });

  it('parses a marker split across many small deltas', async () => {
    const events = [
      ...[...SEARCH_BLOCK].map((char) => assistant(char)),
      successResult(SEARCH_BLOCK),
    ];
    const chunks = await collectChunks(events);

    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([]);
    const calls = chunks.filter((chunk) => chunk.type === 'tool_calls');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toEqual([
      {
        function: { arguments: '{"q":"pong"}', name: 'search' },
        id: toolCallId('search', 0),
        index: 0,
        type: 'function',
      },
    ]);
    expect(chunks.at(-1)?.data).toBe('tool_calls');
  });

  it('flushes a false marker prefix as normal text', async () => {
    const chunks = await collectChunks([
      assistant('<aihub:tool'),
      assistant('_not_the_marker>'),
      successResult('<aihub:tool_not_the_marker>'),
    ]);

    const text = chunks
      .filter((chunk) => chunk.type === 'text')
      .map((chunk) => chunk.data)
      .join('');
    expect(text).toBe('<aihub:tool_not_the_marker>');
    expect(chunks.some((chunk) => chunk.type === 'tool_calls')).toBe(false);
    expect(chunks.at(-1)?.data).toBe('stop');
  });

  it('falls back to raw text when the block JSON is malformed', async () => {
    const block = `${CURSOR_TOOL_CALLS_OPEN}\n{not-json}\n${CURSOR_TOOL_CALLS_CLOSE}`;
    const chunks = await collectChunks([assistant(block), successResult(block)]);

    expect(chunks.filter((chunk) => chunk.type === 'tool_calls')).toEqual([]);
    expect(
      chunks
        .filter((chunk) => chunk.type === 'text')
        .map((chunk) => chunk.data)
        .join(''),
    ).toBe(block);
    expect(chunks.at(-1)?.data).toBe('stop');
  });

  it('streams text before the marker then emits the calls', async () => {
    const full = `Let me look that up.\n${SEARCH_BLOCK}`;
    const chunks = await collectChunks([assistant(full), successResult(full)]);

    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([
      { data: 'Let me look that up.\n', id: TOOL_CALL_ID, type: 'text' },
    ]);
    expect(chunks.filter((chunk) => chunk.type === 'tool_calls')).toHaveLength(1);
    expect(chunks.at(-1)?.data).toBe('tool_calls');
  });

  it('emits parallel tool calls in one chunk', async () => {
    const chunks = await collectChunks([assistant(PARALLEL_BLOCK), successResult(PARALLEL_BLOCK)]);
    const calls = chunks.find((chunk) => chunk.type === 'tool_calls');

    expect(calls?.data).toEqual([
      {
        function: { arguments: '{"q":"pong"}', name: 'search' },
        id: toolCallId('search', 0),
        index: 0,
        type: 'function',
      },
      {
        function: { arguments: '{"city":"NYC"}', name: 'weather' },
        id: toolCallId('weather', 1),
        index: 1,
        type: 'function',
      },
    ]);
    expect(chunks.at(-1)?.data).toBe('tool_calls');
  });

  it('does not double-emit a full-replay assistant event', async () => {
    const chunks = await collectChunks([
      assistant(SEARCH_BLOCK),
      assistant(SEARCH_BLOCK),
      successResult(SEARCH_BLOCK),
    ]);

    expect(chunks.filter((chunk) => chunk.type === 'tool_calls')).toHaveLength(1);
  });

  it('suppresses whitespace-only result leftover after a valid terminal block', async () => {
    const full = `Let me look that up.\n${SEARCH_BLOCK}`;
    const chunks = await collectChunks([
      assistant('Let me look that up.\n'),
      assistant(SEARCH_BLOCK),
      successResult(`${full}\n  `),
    ]);

    expect(joinedText(chunks)).toBe('Let me look that up.\n');
    expect(chunks.filter((chunk) => chunk.type === 'tool_calls')).toHaveLength(1);
    expect(chunks.at(-1)?.data).toBe('tool_calls');
  });

  it('flushes an unseen non-whitespace result suffix as raw text', async () => {
    const chunks = await collectChunks([
      assistant(SEARCH_BLOCK),
      successResult(`${SEARCH_BLOCK} trailing prose`),
    ]);

    expect(chunks.filter((chunk) => chunk.type === 'tool_calls')).toEqual([]);
    expect(joinedText(chunks)).toBe(`${SEARCH_BLOCK} trailing prose`);
    expect(chunks.at(-1)?.data).toBe('stop');
  });

  it('completes a split marker when the close tag only arrives on result', async () => {
    const openAndJson = `${CURSOR_TOOL_CALLS_OPEN}\n${JSON.stringify([{ name: 'search', arguments: { q: 'pong' } }])}\n`;
    const chunks = await collectChunks([
      assistant(openAndJson),
      successResult(`${openAndJson}${CURSOR_TOOL_CALLS_CLOSE}`),
    ]);

    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([]);
    expect(chunks.filter((chunk) => chunk.type === 'tool_calls')).toHaveLength(1);
    expect(chunks.at(-1)?.data).toBe('tool_calls');
  });

  it('passes a marker-literal through when parseToolCalls is off', async () => {
    const chunks = await collectChunks([assistant(SEARCH_BLOCK), successResult(SEARCH_BLOCK)], {
      parseToolCalls: false,
    });

    expect(chunks.filter((chunk) => chunk.type === 'tool_calls')).toEqual([]);
    expect(joinedText(chunks)).toBe(SEARCH_BLOCK);
    expect(chunks.at(-1)?.data).toBe('stop');
  });

  it('flushes a mid-sentence marker with trailing prose as raw text', async () => {
    const full = `see ${SEARCH_BLOCK} in the docs`;
    const chunks = await collectChunks([assistant(full), successResult(full)]);

    expect(chunks.filter((chunk) => chunk.type === 'tool_calls')).toEqual([]);
    expect(joinedText(chunks)).toBe(full);
    expect(chunks.at(-1)?.data).toBe('stop');
  });

  it('flushes two blocks as raw text', async () => {
    const full = `${SEARCH_BLOCK}\n${SEARCH_BLOCK}`;
    const chunks = await collectChunks([assistant(full), successResult(full)]);

    expect(chunks.filter((chunk) => chunk.type === 'tool_calls')).toEqual([]);
    expect(joinedText(chunks)).toBe(full);
    expect(chunks.at(-1)?.data).toBe('stop');
  });

  it('flushes a partial candidate as text when the iterator throws', async () => {
    const partial = `${CURSOR_TOOL_CALLS_OPEN}\n[{"name":"search"`;
    async function* aborting() {
      yield assistant(partial);
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }

    const chunks: StreamProtocolChunk[] = [];
    await expect(async () => {
      for await (const chunk of transformCursorEvents(aborting(), {
        parseToolCalls: true,
        streamStack: { id: TOOL_CALL_ID },
      })) {
        chunks.push(chunk);
      }
    }).rejects.toThrow('aborted');

    expect(chunks.filter((chunk) => chunk.type === 'tool_calls')).toEqual([]);
    expect(joinedText(chunks)).toBe(partial);
  });
});
