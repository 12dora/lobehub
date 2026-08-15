import { callerAbortReason, ChatGPTWebError } from '../errors';

export interface SsePayloadOptions {
  /**
   * The stream's own hard-cap signal. When it is the one that fired, the abort
   * is classified as a provider `timeout`; otherwise the caller's own abort
   * reason is re-thrown untouched.
   */
  deadlineSignal?: AbortSignal;
  /** Abort the read when no frame arrives for this long. */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

type RaceOutcome =
  | { kind: 'read'; value: ReadableStreamReadResult<Uint8Array> }
  | { kind: 'abort' }
  | { kind: 'idle' };

/**
 * Yield the payload of every `data:` line of an SSE stream.
 *
 * The upstream protocol is deliberately simple (no `event:` lines, no multi-line
 * data accumulation) but it emits payloads a generic SSE parser mishandles: the
 * bare `[DONE]` terminator, the `"v1"` protocol marker, and occasional non-JSON
 * lines. Keep this reader dumb and let the router decide.
 *
 * Any abort — caller cancellation, hard cap, or idle timeout — REJECTS. It must
 * never resolve as a clean EOF: `reader.cancel()` settles the pending read with
 * `{ done: true }`, and letting that win would turn a truncated answer into a
 * seemingly finished one for everything downstream.
 */
export async function* iterSsePayloads(
  body: ReadableStream<Uint8Array>,
  { deadlineSignal, idleTimeoutMs, signal }: SsePayloadOptions = {},
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const cancel = () => {
    void reader.cancel().catch(() => {});
  };

  /**
   * A caller-initiated stop keeps its own `AbortError`; our own deadline becomes
   * a provider `timeout`.
   */
  const abortError = (): unknown => {
    if (signal?.aborted && !deadlineSignal?.aborted) {
      const reason = callerAbortReason(signal);
      if (reason !== undefined) return reason;
    }
    return new ChatGPTWebError('timeout', 'stream aborted before it completed');
  };

  if (signal?.aborted) {
    cancel();
    throw abortError();
  }

  let onAbort: (() => void) | undefined;
  // resolves (never rejects) so it can simply lose the race when a read wins
  const abortRace: Promise<RaceOutcome> | undefined = signal
    ? new Promise<RaceOutcome>((resolve) => {
        onAbort = () => resolve({ kind: 'abort' });
        signal.addEventListener('abort', onAbort, { once: true });
      })
    : undefined;

  const emit = function* (chunk: string): Generator<string> {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload) yield payload;
      }
      newlineIndex = buffer.indexOf('\n');
    }
  };

  try {
    while (true) {
      const pending = reader.read();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const racers: Promise<RaceOutcome>[] = [
        pending.then((value) => ({ kind: 'read', value }) as const),
      ];
      if (abortRace) racers.push(abortRace);
      if (idleTimeoutMs)
        racers.push(
          new Promise<RaceOutcome>((resolve) => {
            idleTimer = setTimeout(() => resolve({ kind: 'idle' }), idleTimeoutMs);
          }),
        );

      let outcome: RaceOutcome;
      try {
        outcome = await Promise.race(racers);
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }

      if (outcome.kind !== 'read') {
        cancel();
        // the read is now unobservable — make sure it cannot reject unhandled
        void pending.catch(() => {});
        throw outcome.kind === 'idle'
          ? new ChatGPTWebError('timeout', `no stream data for ${idleTimeoutMs}ms`)
          : abortError();
      }

      if (outcome.value.done) break;
      yield* emit(decoder.decode(outcome.value.value, { stream: true }));
    }

    // flush a trailing line without a newline
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload) yield payload;
    }
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    cancel();
  }
}
