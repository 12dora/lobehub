import type { Readable } from 'node:stream';

/**
 * Bridge the child's stdout to a web ReadableStream. The stream is closed ONLY on the
 * process `close` event, so a mid-stream curl failure (18 partial transfer, 56 recv
 * error) errors the body instead of being delivered as a clean, silently truncated
 * response.
 */
export const createBodyStream = (params: {
  kill: () => void;
  stallTimeoutMs: number;
  stdout: Readable;
}): {
  fail: (error: unknown) => void;
  finish: () => void;
  push: (chunk: Uint8Array) => void;
  stream: ReadableStream<Uint8Array>;
} => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let settled = false;
  let pendingError: unknown;
  let stallTimer: NodeJS.Timeout | undefined;

  const clearStall = () => {
    if (!stallTimer) return;
    clearTimeout(stallTimer);
    stallTimer = undefined;
  };

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      settled = true;
      clearStall();
      params.kill();
    },
    pull() {
      clearStall();
      params.stdout.resume();
    },
    start(streamController) {
      controller = streamController;
    },
  });

  const fail = (error: unknown) => {
    pendingError = error;
    if (settled) return;
    settled = true;
    clearStall();
    try {
      controller?.error(error);
    } catch {
      // Stream already closed / cancelled by the consumer.
    }
  };

  const finish = () => {
    clearStall();
    if (settled) return;
    if (pendingError) {
      fail(pendingError);
      return;
    }
    settled = true;
    try {
      controller?.close();
    } catch {
      // Consumer cancelled first.
    }
  };

  /** Backpressure watchdog: nobody is reading, so nobody will ever resume the child. */
  const armStall = () => {
    if (stallTimer) return;
    stallTimer = setTimeout(() => {
      stallTimer = undefined;
      fail(
        new TypeError(
          'fetch failed: the ChatGPT Web transport response body was not consumed within 60s; the request was cancelled.',
        ),
      );
      params.kill();
    }, params.stallTimeoutMs);
    stallTimer.unref?.();
  };

  /**
   * Body bytes only: the caller splits the head off the shared stdout stream first, so
   * this never sees a header byte.
   */
  const push = (chunk: Uint8Array) => {
    if (settled) return;
    try {
      controller?.enqueue(chunk);
    } catch {
      settled = true;
      clearStall();
      return;
    }
    if (controller && controller.desiredSize !== null && controller.desiredSize <= 0) {
      params.stdout.pause();
      armStall();
    }
  };

  return { fail, finish, push, stream };
};
