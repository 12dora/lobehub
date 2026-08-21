import type { AgentEvent } from '@lobechat/agent-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeExecutorContext } from '../context';
import { createServerCallLlmStreamSink } from './serverCallLlmStreamSink';

const createSink = () => {
  const events: AgentEvent[] = [];
  const publishStreamChunk = vi.fn(async () => 'event-1');
  const sink = createServerCallLlmStreamSink({
    ctx: {
      operationId: 'op-1',
      stepIndex: 2,
      streamManager: { publishStreamChunk },
    } as unknown as RuntimeExecutorContext,
    events,
    operationLogId: 'op-1:2',
  });

  return { events, publishStreamChunk, sink };
};

const publishedTypes = (publishStreamChunk: ReturnType<typeof vi.fn>) =>
  publishStreamChunk.mock.calls.map(([, , payload]) => payload.chunkType);

describe('ServerCallLlmStreamSink flush ordering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes leftover reasoning before leftover text at end-of-stream', async () => {
    const { events, publishStreamChunk, sink } = createSink();

    await sink.appendThinking('think');
    await sink.appendText('answer');
    await sink.flushEndOfStream();
    sink.clearBuffers();

    expect(publishedTypes(publishStreamChunk)).toEqual(['reasoning', 'text']);
    expect(
      events.map((event) =>
        event.type === 'llm_stream' ? (event.chunk as { type: string }).type : event.type,
      ),
    ).toEqual(['reasoning', 'text']);
  });

  it('drops leftover reasoning once text has already been published', async () => {
    const { publishStreamChunk, sink } = createSink();

    await sink.appendText('answer');
    await sink.flushTextBuffer();
    await sink.appendThinking('late thought');
    await sink.flushEndOfStream();
    sink.clearBuffers();

    expect(publishedTypes(publishStreamChunk)).toEqual(['text']);
  });

  it('still publishes leftover reasoning when no text was published', async () => {
    const { publishStreamChunk, sink } = createSink();

    await sink.appendThinking('think');
    await sink.flushEndOfStream();
    sink.clearBuffers();

    expect(publishedTypes(publishStreamChunk)).toEqual(['reasoning']);
  });

  it('ends the reasoning phase before a later delayed flush can publish leftover thinking', async () => {
    const { publishStreamChunk, sink } = createSink();

    await sink.appendThinking('think');
    await sink.appendText('answer');
    await sink.flushEndOfStream();
    sink.endReasoningPhase();

    await sink.appendThinking('after answer');
    await vi.advanceTimersByTimeAsync(400);
    sink.clearBuffers();

    expect(publishedTypes(publishStreamChunk)).toEqual(['reasoning', 'text']);
  });

  it('does not let a timer-triggered reasoning publish complete after text', async () => {
    const events: AgentEvent[] = [];
    let releaseText!: () => void;
    const publishStreamChunk = vi.fn(async (_operationId, _stepIndex, payload) => {
      if (payload.chunkType === 'text') {
        await new Promise<void>((resolve) => {
          releaseText = resolve;
        });
      }
      return 'event-1';
    });
    const sink = createServerCallLlmStreamSink({
      ctx: {
        operationId: 'op-1',
        stepIndex: 2,
        streamManager: { publishStreamChunk },
      } as unknown as RuntimeExecutorContext,
      events,
      operationLogId: 'op-1:2',
    });

    await sink.appendThinking('think');
    await sink.appendText('answer');

    const textFlush = sink.flushTextBuffer();
    await vi.advanceTimersByTimeAsync(400);
    releaseText();
    await textFlush;

    expect(publishedTypes(publishStreamChunk)).toEqual(['text']);
    expect(
      events.map((event) =>
        event.type === 'llm_stream' ? (event.chunk as { type: string }).type : event.type,
      ),
    ).toEqual(['text']);
  });

  it('cancelAndDrain waits for an in-flight deferred publish before resolving (error path)', async () => {
    const events: AgentEvent[] = [];
    let releaseText!: () => void;
    const publishStreamChunk = vi.fn(async (_operationId, _stepIndex, payload) => {
      if (payload.chunkType === 'text') {
        await new Promise<void>((resolve) => {
          releaseText = resolve;
        });
      }
      return 'event-1';
    });
    const sink = createServerCallLlmStreamSink({
      ctx: {
        operationId: 'op-1',
        stepIndex: 2,
        streamManager: { publishStreamChunk },
      } as unknown as RuntimeExecutorContext,
      events,
      operationLogId: 'op-1:2',
    });

    await sink.appendText('answer');
    const flush = sink.flushTextBuffer();

    let drainDone = false;
    const drain = sink.cancelAndDrain().then(() => {
      drainDone = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(drainDone).toBe(false);
    expect(publishedTypes(publishStreamChunk)).toEqual(['text']);

    releaseText();
    await drain;
    await flush;

    expect(drainDone).toBe(true);
  });

  it('cancelAndDrain drops unflushed buffers so a later timer cannot publish after abort', async () => {
    const { publishStreamChunk, sink } = createSink();

    await sink.appendText('pending');
    await sink.appendThinking('think');
    await sink.cancelAndDrain();
    await vi.advanceTimersByTimeAsync(400);

    expect(publishStreamChunk).not.toHaveBeenCalled();
  });

  it('flushEndOfStream still publishes leftover text if leftover reasoning fails, then rethrows', async () => {
    const events: AgentEvent[] = [];
    const publishStreamChunk = vi.fn(async (_operationId, _stepIndex, payload) => {
      if (payload.chunkType === 'reasoning') {
        throw new Error('reasoning failed');
      }
      return 'event-1';
    });
    const sink = createServerCallLlmStreamSink({
      ctx: {
        operationId: 'op-1',
        stepIndex: 2,
        streamManager: { publishStreamChunk },
      } as unknown as RuntimeExecutorContext,
      events,
      operationLogId: 'op-1:2',
    });

    await sink.appendThinking('think');
    await sink.appendText('answer');

    await expect(sink.flushEndOfStream()).rejects.toThrow('reasoning failed');
    expect(publishedTypes(publishStreamChunk)).toEqual(['reasoning', 'text']);
  });
});
