import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StreamingHandler } from './StreamingHandler';
import { type StreamingCallbacks, type StreamingContext } from './types/streaming';

const createMockCallbacks = (): StreamingCallbacks => ({
  onContentUpdate: vi.fn(),
  onReasoningUpdate: vi.fn(),
  onToolCallsUpdate: vi.fn(),
  onGroundingUpdate: vi.fn(),
  onImagesUpdate: vi.fn(),
  onFilesUpdate: vi.fn(),
  onFileUploadError: vi.fn(),
  uploadBase64File: vi.fn(async () => ({ id: 'file-id', url: 'https://s3/report.pdf' })),
  onReasoningStart: vi.fn(() => 'reasoning-op-id'),
  onReasoningComplete: vi.fn(),
  uploadBase64Image: vi.fn(async () => ({ id: 'img-id', url: 'https://s3/img.png' })),
  transformToolCalls: vi.fn((calls) => calls.map((c: any) => ({ ...c, transformed: true }))),
  toggleToolCallingStreaming: vi.fn(),
});

const mockContext: StreamingContext = {
  messageId: 'msg-1',
  operationId: 'op-1',
  agentId: 'agent-1',
};

describe('StreamingHandler', () => {
  describe('handleChunk - text', () => {
    it('should accumulate text output', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'text', text: 'Hello ' });
      handler.handleChunk({ type: 'text', text: 'World' });

      expect(handler.getOutput()).toBe('Hello World');
      expect(callbacks.onContentUpdate).toHaveBeenCalledTimes(2);
    });

    it('should clean speaker tag from output', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'text', text: '<speaker name="Agent" />\nHello' });

      expect(handler.getOutput()).toBe('Hello');
    });

    it('should clean speaker tag across chunks', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'text', text: '<speaker name="' });
      handler.handleChunk({ type: 'text', text: 'Agent" />\n' });
      handler.handleChunk({ type: 'text', text: 'Hello' });

      expect(handler.getOutput()).toBe('Hello');
    });

    it('should not clean speaker tag if it appears in the middle of content', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'text', text: 'Some content ' });
      handler.handleChunk({ type: 'text', text: '<speaker name="Agent" /> more' });

      // Speaker tag not at the beginning is not cleaned
      expect(handler.getOutput()).toBe('Some content <speaker name="Agent" /> more');
    });
  });

  describe('handleChunk - reasoning', () => {
    it('should start reasoning timer on first chunk', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'reasoning', text: 'Thinking...' });

      expect(callbacks.onReasoningStart).toHaveBeenCalledTimes(1);
      expect(callbacks.onReasoningUpdate).toHaveBeenCalledWith({ content: 'Thinking...' });
    });

    it('should accumulate reasoning content', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'reasoning', text: 'Step 1. ' });
      handler.handleChunk({ type: 'reasoning', text: 'Step 2.' });

      expect(callbacks.onReasoningUpdate).toHaveBeenLastCalledWith({
        content: 'Step 1. Step 2.',
      });
    });

    it('should not start reasoning multiple times', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'reasoning', text: 'A' });
      handler.handleChunk({ type: 'reasoning', text: 'B' });
      handler.handleChunk({ type: 'reasoning', text: 'C' });

      expect(callbacks.onReasoningStart).toHaveBeenCalledTimes(1);
    });

    it('should end reasoning when text chunk arrives', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'reasoning', text: 'Thinking...' });
      await new Promise((r) => setTimeout(r, 10));
      handler.handleChunk({ type: 'text', text: 'Result' });

      expect(callbacks.onReasoningComplete).toHaveBeenCalledWith('reasoning-op-id');
      expect(handler.getThinkingDuration()).toBeGreaterThan(0);
    });

    it('starts reasoning only once when reasoning resumes after text', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'reasoning', text: 'first pass' });
      handler.handleChunk({ type: 'text', text: 'answer' });
      handler.handleChunk({ type: 'reasoning', text: 'trailing thought' });

      expect(callbacks.onReasoningStart).toHaveBeenCalledTimes(1);
      expect(callbacks.onReasoningComplete).toHaveBeenCalledTimes(1);
    });

    it('should end reasoning on usage', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'reasoning', text: 'Thinking...' });
      await new Promise((r) => setTimeout(r, 10));
      handler.handleChunk({ type: 'usage', usage: { totalTokens: 10 } as never });

      expect(callbacks.onReasoningComplete).toHaveBeenCalledWith('reasoning-op-id');
      expect(handler.getThinkingDuration()).toBeGreaterThan(0);
    });
  });

  describe('handleChunk - reasoning_part', () => {
    it('should handle text reasoning parts', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'reasoning_part',
        partType: 'text',
        content: 'Thinking...',
      });

      expect(callbacks.onReasoningStart).toHaveBeenCalled();
      expect(callbacks.onReasoningUpdate).toHaveBeenCalledWith({
        content: 'Thinking...',
      });
    });

    it('should merge consecutive text reasoning parts', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'reasoning_part',
        partType: 'text',
        content: 'Step 1. ',
      });
      handler.handleChunk({
        type: 'reasoning_part',
        partType: 'text',
        content: 'Step 2.',
      });

      expect(callbacks.onReasoningUpdate).toHaveBeenLastCalledWith({
        content: 'Step 1. Step 2.',
      });
    });

    it('should handle image reasoning parts with upload', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'reasoning_part',
        partType: 'image',
        content: 'base64data',
        mimeType: 'image/png',
      });

      expect(callbacks.onReasoningUpdate).toHaveBeenCalledWith({
        tempDisplayContent: expect.any(Array),
        isMultimodal: true,
      });
      expect(callbacks.uploadBase64Image).toHaveBeenCalled();
    });
  });

  describe('handleChunk - content_part', () => {
    it('should handle text content parts', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'content_part',
        partType: 'text',
        content: 'Hello',
      });

      expect(handler.getOutput()).toBe('Hello');
    });

    it('should clean speaker tag from content parts', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'content_part',
        partType: 'text',
        content: '<speaker name="Agent" />\nHello',
      });

      expect(handler.getOutput()).toBe('Hello');
    });

    it('should handle image content parts with upload', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'content_part',
        partType: 'image',
        content: 'base64data',
        mimeType: 'image/png',
      });

      expect(callbacks.uploadBase64Image).toHaveBeenCalled();

      // Finish to wait for uploads
      await handler.handleFinish({ type: 'stop' });

      expect(callbacks.uploadBase64Image).toHaveBeenCalled();
    });

    it('should merge consecutive text content parts', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'content_part',
        partType: 'text',
        content: 'Hello ',
      });
      handler.handleChunk({
        type: 'content_part',
        partType: 'text',
        content: 'World',
      });

      expect(handler.getOutput()).toBe('Hello World');
    });
  });

  describe('handleChunk - tool_calls', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should mark as function call', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'tool_calls',
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } },
        ],
      });

      expect(handler.getIsFunctionCall()).toBe(true);
      expect(callbacks.toggleToolCallingStreaming).toHaveBeenCalled();
    });

    it('should throttle tool calls updates', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'tool_calls',
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } },
        ],
      });

      handler.handleChunk({
        type: 'tool_calls',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"test"}' },
          },
        ],
      });

      // Initial call happens immediately due to leading: true
      expect(callbacks.onToolCallsUpdate).toHaveBeenCalledTimes(1);

      // Advance timer to allow trailing call
      vi.advanceTimersByTime(300);

      expect(callbacks.onToolCallsUpdate).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleChunk - grounding', () => {
    it('should update grounding with citations', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'grounding',
        grounding: {
          citations: [{ title: 'Source 1', url: 'https://example.com' }],
          searchQueries: ['test query'],
        },
      });

      expect(callbacks.onGroundingUpdate).toHaveBeenCalledWith({
        citations: [{ title: 'Source 1', url: 'https://example.com' }],
        searchQueries: ['test query'],
      });
    });

    it('should not update grounding when no citations', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'grounding',
        grounding: { citations: [] },
      });

      expect(callbacks.onGroundingUpdate).not.toHaveBeenCalled();
    });

    it('should not update grounding when grounding is undefined', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'grounding',
        grounding: undefined,
      });

      expect(callbacks.onGroundingUpdate).not.toHaveBeenCalled();
    });
  });

  describe('handleChunk - base64_image', () => {
    it('should immediately display images', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'base64_image',
        image: { id: 'img-1', data: 'data:image/png;base64,abc' },
        images: [{ id: 'img-1', data: 'data:image/png;base64,abc' }],
      });

      expect(callbacks.onImagesUpdate).toHaveBeenCalledWith([
        { id: 'img-1', url: 'data:image/png;base64,abc', alt: 'img-1' },
      ]);
    });

    it('should start upload task for image', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'base64_image',
        image: { id: 'img-1', data: 'data:image/png;base64,abc' },
        images: [{ id: 'img-1', data: 'data:image/png;base64,abc' }],
      });

      expect(callbacks.uploadBase64Image).toHaveBeenCalledWith('data:image/png;base64,abc');
    });
  });

  describe('handleChunk - file', () => {
    const fileChunk = {
      type: 'file' as const,
      file: {
        data: 'data:application/pdf;base64,JVBERi0xLjQK',
        id: 'tmp_file_1',
        mimeType: 'application/pdf',
        name: 'report.pdf',
        size: 2048,
        sourcePath: '/mnt/data/report.pdf',
      },
    };

    it('should immediately display an optimistic file entry', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk(fileChunk);

      expect(callbacks.onFilesUpdate).toHaveBeenCalledWith([
        { fileType: 'application/pdf', id: 'tmp_file_1', name: 'report.pdf', size: 2048, url: '' },
      ]);
    });

    it('should start an upload task with filename and mime type', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk(fileChunk);

      expect(callbacks.uploadBase64File).toHaveBeenCalledWith(
        'data:application/pdf;base64,JVBERi0xLjQK',
        { filename: 'report.pdf', mimeType: 'application/pdf', signal: undefined },
      );
    });

    it('should swap the temp entry for the uploaded file', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk(fileChunk);
      await handler.handleFinish({ type: 'stop' });

      expect(callbacks.onFilesUpdate).toHaveBeenLastCalledWith([
        {
          fileType: 'application/pdf',
          id: 'file-id',
          name: 'report.pdf',
          size: 2048,
          url: 'https://s3/report.pdf',
        },
      ]);
    });

    it('should ignore a file chunk without data', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'file',
        file: { data: '', id: 'tmp_file_2', mimeType: 'application/pdf', name: 'x.pdf' },
      });

      expect(callbacks.onFilesUpdate).not.toHaveBeenCalled();
      expect(callbacks.uploadBase64File).not.toHaveBeenCalled();
    });

    it('should wait for file uploads and expose them in the finish metadata', async () => {
      const callbacks = createMockCallbacks();
      callbacks.uploadBase64File = vi.fn(
        (): Promise<{ id: string; url: string } | undefined> =>
          new Promise((r) =>
            setTimeout(() => r({ id: 'file-id', url: 'https://s3/report.pdf' }), 50),
          ),
      );
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk(fileChunk);

      const result = await handler.handleFinish({ type: 'stop' });

      expect(result.metadata.fileList).toEqual([
        {
          fileType: 'application/pdf',
          id: 'file-id',
          name: 'report.pdf',
          size: 2048,
          url: 'https://s3/report.pdf',
        },
      ]);
    });

    it('should not fail the stream when the upload rejects', async () => {
      const callbacks = createMockCallbacks();
      callbacks.uploadBase64File = vi.fn(async () => {
        throw new Error('boom');
      });
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk(fileChunk);

      const result = await handler.handleFinish({ type: 'stop' });

      expect(result.metadata.fileList).toBeUndefined();
    });

    it('should remove the failed card and report the failure to the caller', async () => {
      const callbacks = createMockCallbacks();
      callbacks.uploadBase64File = vi.fn(async () => {
        throw new Error('boom');
      });
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk(fileChunk);
      await handler.handleFinish({ type: 'stop' });

      // the optimistic card is dropped — it can never resolve to a real file
      expect(callbacks.onFilesUpdate).toHaveBeenLastCalledWith([]);
      expect(callbacks.onFileUploadError).toHaveBeenCalledWith({
        error: expect.any(Error),
        name: 'report.pdf',
      });
    });

    it('should treat an upload without id/url as a failure', async () => {
      const callbacks = createMockCallbacks();
      callbacks.uploadBase64File = vi.fn(async () => undefined);
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk(fileChunk);
      const result = await handler.handleFinish({ type: 'stop' });

      expect(result.metadata.fileList).toBeUndefined();
      expect(callbacks.onFilesUpdate).toHaveBeenLastCalledWith([]);
      expect(callbacks.onFileUploadError).toHaveBeenCalledTimes(1);
    });

    it('should run at most 3 uploads at the same time', async () => {
      const callbacks = createMockCallbacks();
      const releases: ((value: { id: string; url: string }) => void)[] = [];
      callbacks.uploadBase64File = vi.fn(
        (): Promise<{ id: string; url: string } | undefined> =>
          new Promise((resolve) => releases.push(resolve)),
      );
      const handler = new StreamingHandler(mockContext, callbacks);

      for (let i = 0; i < 5; i++) {
        handler.handleChunk({
          type: 'file',
          file: { ...fileChunk.file, id: `tmp_file_${i}`, name: `report-${i}.pdf` },
        });
      }

      // all 5 cards are displayed immediately…
      expect(callbacks.onFilesUpdate).toHaveBeenCalledTimes(5);
      // …but only 3 uploads have actually started
      expect(callbacks.uploadBase64File).toHaveBeenCalledTimes(3);

      releases[0]({ id: 'file-0', url: 'https://s3/0.pdf' });
      await vi.waitFor(() => expect(callbacks.uploadBase64File).toHaveBeenCalledTimes(4));

      releases[1]({ id: 'file-1', url: 'https://s3/1.pdf' });
      await vi.waitFor(() => expect(callbacks.uploadBase64File).toHaveBeenCalledTimes(5));

      for (const [index, release] of releases.entries())
        release({ id: `file-${index}`, url: `https://s3/${index}.pdf` });

      const result = await handler.handleFinish({ type: 'stop' });
      expect(result.metadata.fileList).toHaveLength(5);
    });

    describe('abort', () => {
      it('should skip uploads that have not started yet', async () => {
        const controller = new AbortController();
        const callbacks = createMockCallbacks();
        const releases: ((value: { id: string; url: string }) => void)[] = [];
        callbacks.uploadBase64File = vi.fn(
          (): Promise<{ id: string; url: string } | undefined> =>
            new Promise((resolve) => releases.push(resolve)),
        );
        const handler = new StreamingHandler(
          { ...mockContext, abortSignal: controller.signal },
          callbacks,
        );

        for (let i = 0; i < 5; i++) {
          handler.handleChunk({
            type: 'file',
            file: { ...fileChunk.file, id: `tmp_file_${i}`, name: `report-${i}.pdf` },
          });
        }

        expect(callbacks.uploadBase64File).toHaveBeenCalledTimes(3);

        // first upload completes, then the user stops the answer
        releases[0]({ id: 'file-0', url: 'https://s3/0.pdf' });
        await vi.waitFor(() => expect(callbacks.uploadBase64File).toHaveBeenCalledTimes(4));
        controller.abort();

        // release the running ones so the queue drains; the queued 5th one is skipped
        releases[1]({ id: 'file-1', url: 'https://s3/1.pdf' });
        releases[2]({ id: 'file-2', url: 'https://s3/2.pdf' });
        releases[3]({ id: 'file-3', url: 'https://s3/3.pdf' });
        await new Promise((resolve) => setTimeout(resolve, 20));

        // the 5th upload never started
        expect(callbacks.uploadBase64File).toHaveBeenCalledTimes(4);
        expect(callbacks.onFileUploadError).not.toHaveBeenCalled();
      });

      it('should finish without waiting for pending uploads and keep completed ones', async () => {
        const controller = new AbortController();
        const callbacks = createMockCallbacks();
        let resolveSecond: ((value: { id: string; url: string }) => void) | undefined;
        callbacks.uploadBase64File = vi.fn(
          (_data: string, options: { filename: string }) =>
            new Promise<{ id: string; url: string } | undefined>((resolve) => {
              if (options.filename === 'done.pdf')
                resolve({ id: 'file-done', url: 'https://s3/d' });
              else resolveSecond = resolve;
            }),
        );
        const handler = new StreamingHandler(
          { ...mockContext, abortSignal: controller.signal },
          callbacks,
        );

        handler.handleChunk({
          type: 'file',
          file: { ...fileChunk.file, id: 'tmp_done', name: 'done.pdf' },
        });
        handler.handleChunk({
          type: 'file',
          file: { ...fileChunk.file, id: 'tmp_pending', name: 'pending.pdf' },
        });

        // let the resolved upload settle
        await vi.waitFor(() =>
          expect(callbacks.onFilesUpdate).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ id: 'file-done' })]),
          ),
        );

        controller.abort();

        // never resolves — handleFinish must not hang on it
        const result = await handler.handleFinish({ type: 'abort' });

        expect(result.metadata.fileList).toEqual([
          expect.objectContaining({ id: 'file-done', name: 'done.pdf' }),
        ]);
        expect(resolveSecond).toBeDefined();
      });
    });

    it('should leave fileList undefined when no file chunk arrived', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'text', text: 'hi' });
      const result = await handler.handleFinish({ type: 'stop' });

      expect(result.metadata.fileList).toBeUndefined();
    });
  });

  describe('handleChunk - stop', () => {
    it('should end reasoning on stop', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'reasoning', text: 'Thinking...' });
      await new Promise((r) => setTimeout(r, 10));
      handler.handleChunk({ type: 'stop' });

      expect(callbacks.onReasoningComplete).toHaveBeenCalledWith('reasoning-op-id');
    });
  });

  describe('handleFinish', () => {
    it('should return correct result for text-only content', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'text', text: 'Hello World' });

      const result = await handler.handleFinish({
        type: 'stop',
        usage: { totalTokens: 100 } as any,
      });

      expect(result.content).toBe('Hello World');
      expect(result.isFunctionCall).toBe(false);
      expect(result.metadata.usage?.totalTokens).toBe(100);
    });

    it('should wait for image uploads', async () => {
      const callbacks = createMockCallbacks();
      callbacks.uploadBase64Image = vi.fn(
        (): Promise<{ id?: string; url?: string }> =>
          new Promise((r) => setTimeout(() => r({ id: 'img', url: 'https://s3/img.png' }), 50)),
      );
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'base64_image',
        image: { id: 'img-1', data: 'base64...' },
        images: [{ id: 'img-1', data: 'base64...' }],
      });

      const result = await handler.handleFinish({ type: 'stop' });

      expect(result.metadata.imageList).toHaveLength(1);
      expect(result.metadata.imageList?.[0].url).toBe('https://s3/img.png');
    });

    it('should include reasoning with duration', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'reasoning', text: 'Thinking...' });
      await new Promise((r) => setTimeout(r, 20));
      handler.handleChunk({ type: 'text', text: 'Done' });

      const result = await handler.handleFinish({ type: 'stop' });

      expect(result.metadata.reasoning?.content).toBe('Thinking...');
      expect(result.metadata.reasoning?.duration).toBeGreaterThan(0);
    });

    it('ends reasoning on handleFinish when no text or stop arrived', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'reasoning', text: 'Thinking...' });
      await new Promise((r) => setTimeout(r, 10));

      const result = await handler.handleFinish({ type: 'stop' });

      expect(callbacks.onReasoningComplete).toHaveBeenCalledWith('reasoning-op-id');
      expect(result.metadata.reasoning?.duration).toBeGreaterThan(0);
      expect(handler.getThinkingDuration()).toBeGreaterThan(0);
    });

    it('should include grounding from finish data', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'text', text: 'Content' });

      const result = await handler.handleFinish({
        type: 'stop',
        grounding: {
          citations: [{ title: 'Source', url: 'https://example.com' }],
          searchQueries: ['query'],
        },
      });

      expect(result.metadata.search).toEqual({
        citations: [{ title: 'Source', url: 'https://example.com' }],
        searchQueries: ['query'],
      });
    });

    it('should process tool calls from finish data', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      const result = await handler.handleFinish({
        type: 'stop',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"test"}' },
          },
        ],
      });

      expect(result.isFunctionCall).toBe(true);
      expect(result.tools).toBeDefined();
      expect(callbacks.transformToolCalls).toHaveBeenCalled();
    });

    it('should handle empty tool call arguments', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      const result = await handler.handleFinish({
        type: 'stop',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'search', arguments: undefined as unknown as string },
          },
        ],
      });

      expect(result.isFunctionCall).toBe(true);
      // Verify arguments were filled with '{}'
      expect(callbacks.transformToolCalls).toHaveBeenCalledWith([
        { id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } },
      ]);
    });

    it('should update traceId from finish data', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'text', text: 'Content' });

      const result = await handler.handleFinish({
        type: 'stop',
        traceId: 'trace-123',
      });

      expect(result.traceId).toBe('trace-123');
      expect(handler.getTraceId()).toBe('trace-123');
    });

    it('should use fallback reasoning from finish data when no streaming reasoning', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'text', text: 'Content' });

      const result = await handler.handleFinish({
        type: 'stop',
        reasoning: { content: 'Fallback reasoning' },
      });

      expect(result.metadata.reasoning?.content).toBe('Fallback reasoning');
    });

    it('should include reasoning signature from finish data', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'reasoning', text: 'Thinking...' });
      await new Promise((r) => setTimeout(r, 10));
      handler.handleChunk({ type: 'text', text: 'Done' });

      const result = await handler.handleFinish({
        type: 'stop',
        reasoning: { content: 'Thinking...', signature: 'test-signature-abc123' },
      });

      expect(result.metadata.reasoning?.content).toBe('Thinking...');
      expect(result.metadata.reasoning?.signature).toBe('test-signature-abc123');
    });

    it('should include reasoning signature with multimodal reasoning', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({
        type: 'reasoning_part',
        partType: 'text',
        content: 'Thinking with images...',
      });
      handler.handleChunk({
        type: 'reasoning_part',
        partType: 'image',
        content: 'base64data',
        mimeType: 'image/png',
      });
      handler.handleChunk({ type: 'text', text: 'Done' });

      const result = await handler.handleFinish({
        type: 'stop',
        reasoning: { signature: 'multimodal-signature-xyz' },
      });

      expect(result.metadata.reasoning?.isMultimodal).toBe(true);
      expect(result.metadata.reasoning?.signature).toBe('multimodal-signature-xyz');
    });

    it('should use fallback reasoning with signature when no streaming reasoning', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'text', text: 'Content' });

      const result = await handler.handleFinish({
        type: 'stop',
        reasoning: { content: 'Fallback', signature: 'fallback-sig' },
      });

      expect(result.metadata.reasoning?.content).toBe('Fallback');
      expect(result.metadata.reasoning?.signature).toBe('fallback-sig');
    });

    it('should preserve a reasoning signature without reasoning content', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'text', text: 'Content' });

      const result = await handler.handleFinish({
        reasoning: { signature: 'signature-only' },
        type: 'stop',
      });

      expect(result.metadata.reasoning?.content).toBeUndefined();
      expect(result.metadata.reasoning?.signature).toBe('signature-only');
    });

    it('should preserve response items when only hidden reasoning items exist', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);
      const responseItem = {
        encrypted_content: 'scoped-encrypted',
        id: 'rs_hidden',
        summary: [],
        type: 'reasoning' as const,
      };

      handler.handleChunk({ type: 'text', text: 'Content' });

      const result = await handler.handleFinish({
        reasoning: { responseItems: [responseItem] },
        type: 'stop',
      });

      expect(result.metadata.reasoning?.responseItems).toEqual([responseItem]);
    });

    it('should carry response items alongside streamed thinking content', async () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);
      const responseItem = {
        encrypted_content: 'scoped-encrypted',
        id: 'rs_1',
        summary: [{ text: 'streamed thinking', type: 'summary_text' as const }],
        type: 'reasoning' as const,
      };

      handler.handleChunk({ type: 'reasoning', text: 'streamed thinking' });
      handler.handleChunk({ type: 'text', text: 'Content' });

      const result = await handler.handleFinish({
        reasoning: {
          content: 'streamed thinking',
          responseItems: [responseItem],
          signature: 'scoped-signature',
        },
        type: 'stop',
      });

      expect(result.metadata.reasoning?.content).toBe('streamed thinking');
      expect(result.metadata.reasoning?.responseItems).toEqual([responseItem]);
      expect(result.metadata.reasoning?.signature).toBe('scoped-signature');
    });
  });

  describe('getter methods', () => {
    it('getOutput should return accumulated output', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'text', text: 'Test' });

      expect(handler.getOutput()).toBe('Test');
    });

    it('getIsFunctionCall should return false by default', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      expect(handler.getIsFunctionCall()).toBe(false);
    });

    it('getTools should return undefined by default', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      expect(handler.getTools()).toBeUndefined();
    });

    it('getThinkingDuration should return undefined before reasoning ends', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      handler.handleChunk({ type: 'reasoning', text: 'Thinking' });

      expect(handler.getThinkingDuration()).toBeUndefined();
    });

    it('getFinishType should return undefined before finish', () => {
      const callbacks = createMockCallbacks();
      const handler = new StreamingHandler(mockContext, callbacks);

      expect(handler.getFinishType()).toBeUndefined();
    });
  });
});
