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
      hadError: false,
      hadOutput: true,
      hadText: true,
      recoveryRequired: false,
      searchUsed: true,
      text: 'v24',
    });
    expect(eventTypes(raw)).toEqual(['text', 'grounding', 'usage', 'stop']);
    expect(raw).toContain('https://nodejs.org');
  });

  // The upstream silently substitutes a lighter model (quota / risk), and the
  // stream is otherwise tagged with the model we ASKED for — so the served slug
  // has to reach the caller instead of being parsed and dropped.
  it('reports the model the upstream actually served', async () => {
    const onDone = vi.fn(async () => undefined);

    await collect(
      ChatGPTWebStream(
        fromEvents([
          { conversationId: 'conv-3', type: 'conversation.start' },
          { modelSlug: 'gpt-5-6-mini', type: 'metadata' },
          { delta: 'hi', text: 'hi', type: 'text.delta' },
          { type: 'done' },
        ]),
        { model: 'gpt-5-6', onDone },
      ),
    );

    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ servedModel: 'gpt-5-6-mini' }));
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

  describe('generated files', () => {
    const filePointer = {
      conversationId: 'conv-1',
      messageId: 'answer-1',
      name: 'aihub-test.pdf',
      sandboxPath: '/mnt/data/aihub-test.pdf',
      type: 'file.pointer' as const,
    };

    const pdfFile = {
      data: 'data:application/pdf;base64,JVBERi0xLjQ=',
      mimeType: 'application/pdf',
      name: 'aihub-test.pdf',
      size: 9,
      sourcePath: '/mnt/data/aihub-test.pdf',
    };

    it('resolves file pointers into file chunks keyed by the message id', async () => {
      const resolveFile = vi.fn(async () => pdfFile);

      const raw = await collect(
        ChatGPTWebStream(
          fromEvents([
            { conversationId: 'conv-1', type: 'conversation.start' },
            { delta: 'Done', text: 'Done', type: 'text.delta' },
            filePointer,
            { type: 'done' },
          ]),
          { resolveFile },
        ),
      );

      expect(resolveFile).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        messageId: 'answer-1',
        name: 'aihub-test.pdf',
        sandboxPath: '/mnt/data/aihub-test.pdf',
      });
      expect(eventTypes(raw)).toEqual(['text', 'file', 'usage', 'stop']);
      expect(raw).toContain('id: answer-1\nevent: file');
      const line = raw.split('\n').find((item) => item.includes('"mimeType"'))!;
      expect(JSON.parse(line.slice('data: '.length))).toEqual(pdfFile);
    });

    it('falls back to the conversation id seen on the stream', async () => {
      const resolveFile = vi.fn(async () => pdfFile);

      await collect(
        ChatGPTWebStream(
          fromEvents([
            { conversationId: 'conv-9', type: 'conversation.start' },
            { ...filePointer, conversationId: undefined },
            { type: 'done' },
          ]),
          { resolveFile },
        ),
      );

      expect(resolveFile).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-9' }),
      );
    });

    it('resolves a repeated pointer only once', async () => {
      const resolveFile = vi.fn(async () => pdfFile);

      const raw = await collect(
        ChatGPTWebStream(fromEvents([filePointer, filePointer, { type: 'done' }]), { resolveFile }),
      );

      expect(resolveFile).toHaveBeenCalledTimes(1);
      expect(eventTypes(raw)).toEqual(['file', 'usage', 'stop']);
    });

    it('still delivers the answer when a file fails to resolve', async () => {
      const resolveFile = vi.fn(async () => {
        throw new Error('404 from the asset host');
      });

      const raw = await collect(
        ChatGPTWebStream(
          fromEvents([
            filePointer,
            { delta: 'here you go', text: 'here you go', type: 'text.delta' },
            { type: 'done' },
          ]),
          { resolveFile },
        ),
      );

      expect(eventTypes(raw)).toEqual(['text', 'usage', 'stop']);
      expect(raw).toContain('here you go');
    });

    it('emits nothing when the file is over the size cap (resolver returns nothing)', async () => {
      const resolveFile = vi.fn(async () => undefined);

      const raw = await collect(
        ChatGPTWebStream(fromEvents([filePointer, { type: 'done' }]), { resolveFile }),
      );

      expect(eventTypes(raw)).toEqual(['usage', 'stop']);
    });

    it('ends as an abort when the caller stops during file resolution', async () => {
      const controller = new AbortController();
      const onDone = vi.fn(async () => undefined);
      const resolveFile = vi.fn(async () => {
        controller.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      });

      const raw = await collect(
        ChatGPTWebStream(fromEvents([filePointer, { type: 'done' }]), {
          onDone,
          resolveFile,
          signal: controller.signal,
        }),
      );

      expect(raw).toContain('event: stop\ndata: "abort"');
      expect(raw).not.toContain('event: usage');
      expect(onDone).not.toHaveBeenCalled();
    });

    it('delivers the same path from two assistant messages of one turn', async () => {
      // two code-interpreter steps, each writing its own /mnt/data/out.csv
      const resolveFile = vi.fn(async (pointer: any) => ({
        ...pdfFile,
        name: `${pointer.messageId}.pdf`,
      }));

      const raw = await collect(
        ChatGPTWebStream(
          fromEvents([filePointer, { ...filePointer, messageId: 'answer-2' }, { type: 'done' }]),
          { resolveFile },
        ),
      );

      expect(resolveFile).toHaveBeenCalledTimes(2);
      expect(eventTypes(raw)).toEqual(['file', 'file', 'usage', 'stop']);
      expect(raw).toContain('id: answer-1\nevent: file');
      expect(raw).toContain('id: answer-2\nevent: file');
    });

    it('emits files recovered from the conversation document at done, keyed by their message', async () => {
      const onDone = vi.fn(async () => ({
        files: [{ file: pdfFile, messageId: 'recovered-1' }],
        text: 'recovered answer',
      }));

      const raw = await collect(
        ChatGPTWebStream(fromEvents([{ type: 'done' }]), { onDone, resolveFile: vi.fn() }),
      );

      expect(eventTypes(raw)).toEqual(['text', 'file', 'usage', 'stop']);
      expect(raw).toContain('id: recovered-1\nevent: file');
      expect(raw).toContain('aihub-test.pdf');
    });

    it('does not deliver a recovered file the stream already carried', async () => {
      const resolveFile = vi.fn(async () => pdfFile);
      const onDone = vi.fn(async () => ({
        files: [{ file: pdfFile, messageId: filePointer.messageId }],
      }));

      const raw = await collect(
        ChatGPTWebStream(fromEvents([filePointer, { type: 'done' }]), { onDone, resolveFile }),
      );

      expect(eventTypes(raw)).toEqual(['file', 'usage', 'stop']);
    });

    it('recovers a file whose streamed resolution failed', async () => {
      // the stream attempt threw, so the path was never DELIVERED — the
      // recovered answer must be allowed to resolve it again
      const resolveFile = vi.fn(async () => {
        throw new Error('502 from the asset host');
      });
      const onDone = vi.fn(async () => ({
        files: [{ file: pdfFile, messageId: filePointer.messageId }],
      }));

      const raw = await collect(
        ChatGPTWebStream(fromEvents([filePointer, { type: 'done' }]), { onDone, resolveFile }),
      );

      expect(eventTypes(raw)).toEqual(['file', 'usage', 'stop']);
      expect(raw).toContain(`id: ${filePointer.messageId}\nevent: file`);
    });

    it('delivers a recovered file for another message than the one the stream carried', async () => {
      const resolveFile = vi.fn(async () => pdfFile);
      const onDone = vi.fn(async () => ({
        files: [{ file: pdfFile, messageId: 'answer-2' }],
      }));

      const raw = await collect(
        ChatGPTWebStream(fromEvents([filePointer, { type: 'done' }]), { onDone, resolveFile }),
      );

      expect(eventTypes(raw)).toEqual(['file', 'file', 'usage', 'stop']);
    });

    it('ignores file pointers when no resolver is injected', async () => {
      const raw = await collect(ChatGPTWebStream(fromEvents([filePointer, { type: 'done' }])));

      expect(eventTypes(raw)).toEqual(['usage', 'stop']);
    });
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
  describe('failed turns never start the recovery poll', () => {
    it('reports the hard cap once and tells onDone the turn errored', async () => {
      const onDone = vi.fn(async () => undefined);
      const timingOut = async function* (): AsyncGenerator<ConversationEvent> {
        yield { conversationId: 'conv-1', type: 'conversation.start' };
        throw new ChatGPTWebError('timeout', 'stream idled out');
      };

      const raw = await collect(ChatGPTWebStream(timingOut(), { onDone }));

      // exactly one error chunk, then the terminal stop
      expect(eventTypes(raw)).toEqual(['error', 'usage', 'stop']);
      expect(raw).toContain('ProviderNetworkError');
      expect(onDone).toHaveBeenCalledWith(
        expect.objectContaining({ hadError: true, hadOutput: false }),
      );
    });

    it('marks a moderation block and an upstream error as errored', async () => {
      const onDone = vi.fn(async () => undefined);

      await collect(
        ChatGPTWebStream(fromEvents([{ blocked: true, type: 'moderation' }, { type: 'done' }]), {
          onDone,
        }),
      );
      expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ hadError: true }));

      onDone.mockClear();
      await collect(
        ChatGPTWebStream(
          fromEvents([{ message: 'upstream exploded', type: 'error' }, { type: 'done' }]),
          { onDone },
        ),
      );
      expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ hadError: true }));
    });

    it('passes the streamed text and the recovery flag to onDone', async () => {
      const onDone = vi.fn(async () => undefined);

      await collect(
        ChatGPTWebStream(
          fromEvents([
            { delta: 'half an ', text: 'half an ', type: 'text.delta' },
            { delta: 'answer', text: 'half an answer', type: 'text.delta' },
            { recoveryRequired: true, type: 'done' },
          ]),
          { onDone },
        ),
      );

      expect(onDone).toHaveBeenCalledWith(
        expect.objectContaining({ recoveryRequired: true, text: 'half an answer' }),
      );
    });
  });

  it('never re-emits a handoff, not even under debug', async () => {
    const raw = await collect(
      ChatGPTWebStream(
        fromEvents([
          { conversationId: 'c', resumeToken: 'resume-jwt-SECRET', type: 'handoff' },
          { delta: 'x', text: 'x', type: 'text.delta' },
          { type: 'done' },
        ]),
        { debug: true },
      ),
    );

    expect(eventTypes(raw)).toEqual(['text', 'usage', 'stop']);
    expect(raw).not.toContain('resume-jwt-SECRET');
  });

  describe('cleanup', () => {
    it('runs the cleanup hook on a clean turn', async () => {
      const onCleanup = vi.fn();

      await collect(
        ChatGPTWebStream(
          fromEvents([
            { conversationId: 'conv-1', type: 'conversation.start' },
            { delta: 'x', text: 'x', type: 'text.delta' },
            { type: 'done' },
          ]),
          { onCleanup },
        ),
      );

      expect(onCleanup).toHaveBeenCalledWith({ aborted: false, conversationId: 'conv-1' });
    });

    it('runs the cleanup hook when the caller aborts, and starts no recovery', async () => {
      const controller = new AbortController();
      const onDone = vi.fn(async () => undefined);
      const onCleanup = vi.fn();
      const cancelled = async function* (): AsyncGenerator<ConversationEvent> {
        yield { conversationId: 'conv-1', type: 'conversation.start' };
        controller.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      };

      const raw = await collect(
        ChatGPTWebStream(cancelled(), { onCleanup, onDone, signal: controller.signal }),
      );

      expect(raw).toContain('event: stop\ndata: "abort"');
      expect(onDone).not.toHaveBeenCalled();
      expect(onCleanup).toHaveBeenCalledWith({ aborted: true, conversationId: 'conv-1' });
    });

    it('ends as an abort when the caller stops during image resolution', async () => {
      const controller = new AbortController();
      const onDone = vi.fn(async () => undefined);
      const onCleanup = vi.fn();
      const resolveImage = vi.fn(async () => {
        controller.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      });

      const raw = await collect(
        ChatGPTWebStream(
          fromEvents([
            { conversationId: 'conv-1', type: 'conversation.start' },
            {
              assetPointer: 'file-service://img-1',
              fileId: 'img-1',
              pointerKind: 'file-service',
              type: 'image.pointer',
            },
            { type: 'done' },
          ]),
          { onCleanup, onDone, resolveImage, signal: controller.signal },
        ),
      );

      expect(raw).toContain('event: stop\ndata: "abort"');
      expect(raw).not.toContain('event: usage');
      expect(onDone).not.toHaveBeenCalled();
      expect(onCleanup).toHaveBeenCalledWith({ aborted: true, conversationId: 'conv-1' });
    });

    it('still delivers the answer when an image simply fails to resolve', async () => {
      const resolveImage = vi.fn(async () => {
        throw new Error('404 from the asset host');
      });

      const raw = await collect(
        ChatGPTWebStream(
          fromEvents([
            {
              assetPointer: 'file-service://img-1',
              fileId: 'img-1',
              pointerKind: 'file-service',
              type: 'image.pointer',
            },
            { delta: 'here you go', text: 'here you go', type: 'text.delta' },
            { type: 'done' },
          ]),
          { resolveImage },
        ),
      );

      expect(eventTypes(raw)).toEqual(['text', 'usage', 'stop']);
    });
  });
});
