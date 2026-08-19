class QueueTimeoutError extends Error {
  constructor() {
    super('Cursor Agent CLI queue timed out');
    this.name = 'QueueTimeoutError';
  }
}

class QueueOverloadedError extends Error {
  constructor() {
    super('Cursor Agent CLI queue is full');
    this.name = 'QueueOverloadedError';
  }
}

export const createAbortError = (): DOMException =>
  new DOMException('The operation was aborted.', 'AbortError');

export const jsonError = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ error: { code, message } }), {
    headers: { 'content-type': 'application/json' },
    status,
  });

/**
 * FIFO gate. Concurrent CLI processes are capped at `limit`; waiters are capped at
 * `maxQueue` (distinct 503 `overloaded` vs `queue_timeout`).
 *
 * TODO(HANDOFF): per-user fairness cannot be enforced here — the transport has no
 * trusted user identity. Do not accept a client-supplied `userId` header. The
 * ModelRuntime seam should pass a server-authenticated user id into the fetch
 * adapter so this gate can cap per-user in-flight/queued turns. See
 * docs/enterprise/cursor-provider.md.
 */
export class TurnGate {
  private active = 0;
  private readonly waiters: Array<{
    reject: (error: unknown) => void;
    resolve: () => void;
  }> = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueue: number,
  ) {}

  acquire(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(createAbortError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(new QueueOverloadedError());
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const waiter = {
        reject: (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
        resolve: () => {
          if (settled) return;
          settled = true;
          resolve();
        },
      };

      const timer = setTimeout(() => {
        this.removeWaiter(waiter);
        detachAbort();
        waiter.reject(new QueueTimeoutError());
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        this.removeWaiter(waiter);
        waiter.reject(createAbortError());
      };
      const detachAbort = () => signal?.removeEventListener('abort', onAbort);

      const originalResolve = waiter.resolve;
      waiter.resolve = () => {
        clearTimeout(timer);
        detachAbort();
        originalResolve();
      };
      const originalReject = waiter.reject;
      waiter.reject = (error: unknown) => {
        clearTimeout(timer);
        detachAbort();
        originalReject(error);
      };

      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.resolve();
      return;
    }
    if (this.active > 0) this.active -= 1;
  }

  private removeWaiter(waiter: { reject: (error: unknown) => void; resolve: () => void }): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }
}

export const mapGateError = (error: unknown): Response | undefined => {
  if (error instanceof QueueTimeoutError) {
    return jsonError(503, 'queue_timeout', 'Cursor Agent CLI queue timed out');
  }
  if (error instanceof QueueOverloadedError) {
    return jsonError(503, 'overloaded', 'Cursor Agent CLI queue is full');
  }
  return undefined;
};
