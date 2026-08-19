export const BODY_HIGH_WATER_BYTES = 64 * 1024;

export interface BodyBridge {
  bufferedBytes: number;
  fail: (error: unknown) => void;
  finish: () => void;
  maxQueuedBytes: number;
  push: (chunk: Uint8Array) => 'ok' | 'pause' | 'closed';
  stream: ReadableStream<Uint8Array>;
}

const byteLength = (chunk: Uint8Array): number => chunk.byteLength;

/**
 * `bufferedBytes` is the current controller queue (decremented when the
 * consumer pulls), not cumulative accepted bytes.
 */
export const createBodyBridge = (params: {
  highWaterMark?: number;
  onCancel: () => void;
  onPull: () => void;
}): BodyBridge => {
  const highWater = params.highWaterMark ?? BODY_HIGH_WATER_BYTES;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let settled = false;
  let pendingError: unknown;
  let queuedBytes = 0;
  let maxQueuedBytes = 0;

  const refreshQueued = (): void => {
    if (!controller || controller.desiredSize === null) return;
    queuedBytes = Math.max(0, highWater - controller.desiredSize);
    if (queuedBytes > maxQueuedBytes) maxQueuedBytes = queuedBytes;
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      cancel() {
        settled = true;
        queuedBytes = 0;
        params.onCancel();
      },
      pull() {
        refreshQueued();
        params.onPull();
      },
      start(streamController) {
        controller = streamController;
      },
    },
    { highWaterMark: highWater, size: byteLength },
  );

  const fail = (error: unknown) => {
    pendingError = error;
    if (settled) return;
    settled = true;
    queuedBytes = 0;
    try {
      controller?.error(error);
    } catch {
      // Stream already closed / cancelled.
    }
  };

  const finish = () => {
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

  const push = (chunk: Uint8Array): 'ok' | 'pause' | 'closed' => {
    if (settled) return 'closed';
    if (controller && controller.desiredSize !== null && controller.desiredSize <= 0) {
      return 'pause';
    }
    try {
      controller?.enqueue(chunk);
      refreshQueued();
    } catch {
      settled = true;
      return 'closed';
    }
    return 'ok';
  };

  return {
    get bufferedBytes() {
      return queuedBytes;
    },
    fail,
    finish,
    get maxQueuedBytes() {
      return maxQueuedBytes;
    },
    push,
    stream,
  };
};
