import { describe, expect, it } from 'vitest';

import { iterSsePayloads } from './reader';

const streamOf = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
};

const collect = async (chunks: string[]) => {
  const out: string[] = [];
  for await (const payload of iterSsePayloads(streamOf(chunks))) out.push(payload);
  return out;
};

describe('iterSsePayloads', () => {
  it('yields the payload of every data line and ignores everything else', async () => {
    expect(
      await collect([
        'event: delta\n',
        'data: "v1"\n\n',
        'data: {"v":"hello"}\n',
        '\n',
        ': keep-alive comment\n',
        'data: [DONE]\n\n',
      ]),
    ).toEqual(['"v1"', '{"v":"hello"}', '[DONE]']);
  });

  it('joins payloads split across chunk boundaries', async () => {
    expect(await collect(['data: {"v":"he', 'llo world"}\n'])).toEqual(['{"v":"hello world"}']);
  });

  it('handles CRLF line endings and a trailing line without a newline', async () => {
    expect(await collect(['data: a\r\n', 'data: b'])).toEqual(['a', 'b']);
  });

  it('skips empty data lines', async () => {
    expect(await collect(['data:\n', 'data:   \n', 'data: x\n'])).toEqual(['x']);
  });

  it('rejects with the caller reason when aborted while a read is pending', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('data: first\n'));
        // the producer then stalls: `reader.read()` stays pending
      },
    });

    const seen: string[] = [];
    setTimeout(() => controller.abort(), 10);

    await expect(
      (async () => {
        for await (const payload of iterSsePayloads(stream, { signal: controller.signal }))
          seen.push(payload);
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // the partial payload must NOT look like a clean end of stream
    expect(seen).toEqual(['first']);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      (async () => {
        for await (const _payload of iterSsePayloads(streamOf(['data: a\n']), {
          signal: controller.signal,
        }));
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('classifies the hard cap as a provider timeout, not a caller abort', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('data: first\n'));
      },
    });

    setTimeout(() => controller.abort(), 10);

    await expect(
      (async () => {
        for await (const _payload of iterSsePayloads(stream, {
          // the same signal is both the composed signal and the deadline
          deadlineSignal: controller.signal,
          signal: controller.signal,
        }));
      })(),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('times out when no frame arrives within the idle window', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\n'));
      },
    });

    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const payload of iterSsePayloads(stream, { idleTimeoutMs: 20 }))
          seen.push(payload);
      })(),
    ).rejects.toMatchObject({ kind: 'timeout' });

    expect(seen).toEqual(['first']);
  });
});
