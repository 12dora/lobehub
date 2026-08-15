import { describe, expect, it, vi } from 'vitest';

import type { ConversationEvent } from '../../providers/chatgptWeb/client';
import { ChatGPTWebError } from '../../providers/chatgptWeb/client';
import { ChatGPTWebStream } from './chatgptWeb';
import type { StreamContext } from './protocol';

const fromEvents = async function* (events: ConversationEvent[]) {
  for (const event of events) yield event;
};

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

describe('ChatGPTWebStream', () => {
  it('maps text and reasoning deltas, then usage and stop', async () => {
    const raw = await collect(
      ChatGPTWebStream(
        fromEvents([
          { conversationId: 'conv-1', type: 'conversation.start' },
          { delta: 'thinking…', type: 'reasoning.delta' },
          { durationSec: 2, recap: 'Worked for 2 seconds', type: 'reasoning.done' },
          { delta: 'po', text: 'po', type: 'text.delta' },
          { delta: 'ng', text: 'pong', type: 'text.delta' },
          { conversationId: 'conv-1', endTurn: true, type: 'done' },
        ]),
        { inputText: 'ping' },
      ),
    );

    expect(eventTypes(raw)).toEqual(['reasoning', 'text', 'text', 'usage', 'stop']);
    expect(raw).toContain('data: "thinking…"');
    expect(raw).toContain('data: "po"');
    expect(raw).toContain('data: "ng"');
    expect(raw).toContain('event: stop\ndata: "stop"');
  });

  it('emits the reasoning recap only when nothing was streamed', async () => {
    const raw = await collect(
      ChatGPTWebStream(
        fromEvents([
          { durationSec: 3, recap: 'Worked for a couple of seconds', type: 'reasoning.done' },
          { delta: 'hi', text: 'hi', type: 'text.delta' },
          { type: 'done' },
        ]),
      ),
    );

    expect(eventTypes(raw)).toEqual(['reasoning', 'text', 'usage', 'stop']);
    expect(raw).toContain('Worked for a couple of seconds');
  });

  it('emits grounding once, ignoring later citation events', async () => {
    const onDone = vi.fn(async () => ({
      grounding: { citations: [{ title: 'late', url: 'https://late' }] },
    }));

    const raw = await collect(
      ChatGPTWebStream(
        fromEvents([
          { citations: [{ title: 'A', url: 'https://a.example' }], type: 'citations' },
          { delta: 'x', text: 'x', type: 'text.delta' },
          { citations: [{ title: 'B', url: 'https://b.example' }], type: 'citations' },
          { type: 'done' },
        ]),
        { onDone },
      ),
    );

    expect(eventTypes(raw)).toEqual(['grounding', 'text', 'usage', 'stop']);
    expect(raw).toContain('https://a.example');
    expect(raw).not.toContain('https://b.example');
    // onDone still runs (it also hides the conversation), but its grounding is dropped
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ citationsEmitted: true, searchUsed: false }),
    );
  });

  it('fetches citations after done when the turn used search', async () => {
    const onDone = vi.fn(async () => ({
      grounding: { citations: [{ title: 'Node', url: 'https://nodejs.org' }] },
    }));

    const raw = await collect(
      ChatGPTWebStream(
        fromEvents([
          { conversationId: 'conv-2', type: 'conversation.start' },
          { toolInvoked: true, turnUseCase: 'search', type: 'metadata' },
          { delta: 'v24', text: 'v24', type: 'text.delta' },
          { type: 'done' },
        ]),
        { onDone },
      ),
    );

    expect(onDone).toHaveBeenCalledWith({
      citationsEmitted: false,
      conversationId: 'conv-2',
      endTurn: false,
      hadOutput: true,
      hadText: true,
      searchUsed: true,
    });
    expect(eventTypes(raw)).toEqual(['text', 'grounding', 'usage', 'stop']);
    expect(raw).toContain('https://nodejs.org');
  });

  it('resolves image pointers into base64_image chunks', async () => {
    const resolveImage = vi.fn(async () => 'data:image/png;base64,AAAA');

    const raw = await collect(
      ChatGPTWebStream(
        fromEvents([
          {
            assetPointer: 'file-service://file-1',
            fileId: 'file-1',
            pointerKind: 'file-service',
            type: 'image.pointer',
          },
          { type: 'done' },
        ]),
        { resolveImage },
      ),
    );

    expect(resolveImage).toHaveBeenCalledWith({
      assetPointer: 'file-service://file-1',
      fileId: 'file-1',
      pointerKind: 'file-service',
    });
    expect(eventTypes(raw)).toEqual(['base64_image', 'usage', 'stop']);
    expect(raw).toContain('data:image/png;base64,AAAA');
  });

  it('maps moderation and upstream errors to error chunks', async () => {
    const raw = await collect(
      ChatGPTWebStream(
        fromEvents([
          { blocked: true, type: 'moderation' },
          { code: 'boom', message: 'upstream exploded', type: 'error' },
          { type: 'done' },
        ]),
      ),
    );

    expect(eventTypes(raw)).toEqual(['error', 'error', 'usage', 'stop']);
    expect(raw).toContain('ProviderContentPolicyViolation');
    expect(raw).toContain('upstream exploded');
  });

  it('reports a heuristic usage estimate', async () => {
    const raw = await collect(
      ChatGPTWebStream(
        fromEvents([{ delta: 'abcdefgh', text: 'abcdefgh', type: 'text.delta' }, { type: 'done' }]),
        { inputStartAt: Date.now(), inputText: 'abcd' },
      ),
    );

    const usageLine = raw.split('\n').find((line) => line.includes('"totalTokens"'))!;
    const usage = JSON.parse(usageLine.slice('data: '.length));
    expect(usage).toMatchObject({
      inputTextTokens: 1,
      outputTextTokens: 2,
      totalInputTokens: 1,
      totalOutputTokens: 2,
      totalTokens: 3,
    });
    // the speed chunk is derived from usage by the token-speed calculator
    expect(eventTypes(raw)).toContain('speed');
  });

  it('reports the stream hard cap as an error, not as a user cancellation', async () => {
    const timingOut = async function* (): AsyncGenerator<ConversationEvent> {
      yield { delta: 'partial', text: 'partial', type: 'text.delta' };
      // exactly what the SSE reader throws on its hard cap / idle deadline
      throw new ChatGPTWebError('timeout', 'stream aborted before it completed');
    };

    const raw = await collect(ChatGPTWebStream(timingOut()));

    expect(eventTypes(raw)).toEqual(['text', 'error', 'usage', 'stop']);
    expect(raw).toContain('ProviderNetworkError');
    expect(raw).toContain('event: stop\ndata: "stop"');
    expect(raw).not.toContain('data: "abort"');
  });

  it('ends as an abort when the caller cancelled', async () => {
    const controller = new AbortController();
    const cancelled = async function* (): AsyncGenerator<ConversationEvent> {
      yield { delta: 'partial', text: 'partial', type: 'text.delta' };
      controller.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    };

    const raw = await collect(ChatGPTWebStream(cancelled(), { signal: controller.signal }));

    expect(eventTypes(raw)).toEqual(['text', 'stop']);
    expect(raw).toContain('event: stop\ndata: "abort"');
  });

  it('surfaces a failed post-turn recovery as an error chunk', async () => {
    const onDone = vi.fn(async () => {
      throw new ChatGPTWebError('timeout', 'the background answer was never written');
    });

    const raw = await collect(ChatGPTWebStream(fromEvents([{ type: 'done' }]), { onDone }));

    expect(eventTypes(raw)).toEqual(['error', 'usage', 'stop']);
    expect(raw).toContain('ProviderNetworkError');
  });

  it('honours a stack that already returned citations', async () => {
    const stack: StreamContext = { id: 'chat_1', returnedCitation: true };

    const raw = await collect(
      ChatGPTWebStream(
        fromEvents([
          { citations: [{ title: 'A', url: 'https://a.example' }], type: 'citations' },
          { delta: 'x', text: 'x', type: 'text.delta' },
          { type: 'done' },
        ]),
        { streamStack: stack },
      ),
    );

    expect(eventTypes(raw)).toEqual(['text', 'usage', 'stop']);
    expect(raw).not.toContain('https://a.example');
  });

  it('turns a mid-stream failure into an error chunk and still terminates', async () => {
    const failing = async function* (): AsyncGenerator<ConversationEvent> {
      yield { delta: 'partial', text: 'partial', type: 'text.delta' };
      throw new Error('connection reset');
    };

    const raw = await collect(ChatGPTWebStream(failing()));

    expect(eventTypes(raw)).toEqual(['text', 'error', 'usage', 'stop']);
    expect(raw).toContain('connection reset');
  });
});
