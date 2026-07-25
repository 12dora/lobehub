/**
 * Shared WHATWG-fetch transport helpers used by enterprise connection adapters
 * (Azure HttpClient + AWS/Smithy requestHandler). Keeps body buffering, abort
 * composition, and header conversion in one place so both transports stay aligned.
 */

/** Soft cap for buffered async-iterable request bodies (16 MiB). */
export const FETCH_TRANSPORT_MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Normalize SDK request bodies into a BodyInit acceptable by WHATWG fetch.
 * Buffers async iterables up to {@link FETCH_TRANSPORT_MAX_BODY_BYTES}.
 */
export const normalizeFetchBody = async (body: unknown): Promise<BodyInit | undefined> => {
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new Uint8Array(body);
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) return new Uint8Array(body);
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return body;
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return body;
  if (typeof body === 'object' && body !== null && Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of body as AsyncIterable<unknown>) {
      const part = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk));
      total += part.byteLength;
      if (total > FETCH_TRANSPORT_MAX_BODY_BYTES) {
        throw new Error(
          `Request body exceeds fetch transport buffer limit (${FETCH_TRANSPORT_MAX_BODY_BYTES} bytes)`,
        );
      }
      chunks.push(part);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of chunks) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    return merged;
  }
  return new TextEncoder().encode(String(body));
};

/** Suppress bodies on GET/HEAD per HTTP semantics. */
export const bodyForHttpMethod = (
  method: string,
  body: BodyInit | undefined,
): BodyInit | undefined => {
  if (!body) return undefined;
  const upper = method.toUpperCase();
  if (upper === 'GET' || upper === 'HEAD') return undefined;
  return body;
};

/**
 * Compose an external AbortSignal with an optional timeout into one controller.
 * Caller must invoke `cleanup()` in a finally block to drop listeners/timers.
 */
export const composeAbortSignal = (
  external?: AbortSignal,
  timeoutMs?: number,
): { cleanup: () => void; signal: AbortSignal } => {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener('abort', onAbort, { once: true });
    }
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  return {
    cleanup: () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (external) external.removeEventListener('abort', onAbort);
    },
    signal: controller.signal,
  };
};

/** Convert a Response Headers object to a plain string record. */
export const responseHeadersToRecord = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};
