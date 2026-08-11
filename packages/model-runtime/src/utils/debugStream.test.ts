import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { debugStream, serializeDebugPayload } from './debugStream';

describe('debugStream', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should log stream start and end messages', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue('test chunk');
        controller.close();
      },
    });

    await debugStream(stream);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[stream start\]/));
  });

  it('should handle and log stream errors', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue('test chunk');
        controller.error(new Error('stream failed'));
      },
    });

    await debugStream(stream);

    expect(consoleErrorSpy).toHaveBeenCalledWith('[debugStream error]', expect.any(Error));
    expect(consoleErrorSpy).toHaveBeenCalledWith('[error chunk value:]', undefined);
  });

  it('should decode ArrayBuffer chunk values', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('test chunk'));
        controller.close();
      },
    });

    await debugStream(stream);

    expect(consoleLogSpy).toHaveBeenCalledWith('test chunk');
  });

  it('should stringify non-string chunk values', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ test: 'chunk' });
        controller.close();
      },
    });

    await debugStream(stream);

    expect(consoleLogSpy).toHaveBeenCalledWith('{"test":"chunk"}');
  });

  it('redacts encrypted reasoning, scoped signatures, and reasoning summaries', () => {
    const serialized = serializeDebugPayload({
      input: [
        {
          encrypted_content: 'encrypted-secret',
          summary: [{ text: 'private chain', type: 'summary_text' }],
          type: 'reasoning',
        },
      ],
      signature: 'lobe-scoped-state-v1:reasoning:fingerprint:opaque-secret',
      visible: 'keep me',
    });

    expect(serialized).toContain('[redacted:16]');
    expect(serialized).toContain('[redacted:13]');
    expect(serialized).toContain('[redacted:56]');
    expect(serialized).toContain('keep me');
    expect(serialized).not.toContain('encrypted-secret');
    expect(serialized).not.toContain('private chain');
    expect(serialized).not.toContain('opaque-secret');
  });

  it('buffers split SSE lines before redacting reasoning payloads', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"encrypted_content":"split-'));
        controller.enqueue(
          encoder.encode('secret","summary":[{"type":"summary_text","text":"hidden"}]}\n\n'),
        );
        controller.close();
      },
    });

    await debugStream(stream);

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toContain('[redacted:12]');
    expect(output).toContain('[redacted:6]');
    expect(output).not.toContain('split-secret');
    expect(output).not.toContain('hidden');
  });
});
