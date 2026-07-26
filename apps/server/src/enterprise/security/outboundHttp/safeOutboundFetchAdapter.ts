/**
 * Adapt SafeOutboundHttpClient to the standard fetch signature for SDKs
 * that accept a custom fetch (OpenAI-compatible ModelRuntime, etc.).
 * Production callers must inject SafeOutboundHttpClient — never raw fetch.
 */
import { SafeOutboundHttpError } from './errors';
import type { SafeOutboundHttpClient } from './safeOutboundHttpClient';
import type { SafeOutboundRequestInit } from './types';

const DEFAULT_ADAPTER_TIMEOUT_MS = 15_000;
const DEFAULT_ADAPTER_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_ADAPTER_MAX_REDIRECTS = 3;
/** Hard cap on request-body bytes while normalizing (before SafeOutboundHttpClient starts). */
export const DEFAULT_ADAPTER_MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export interface SafeOutboundFetchAdapterOptions {
  maxRedirects?: number;
  /** Max request body bytes during Request/BodyInit normalization. */
  maxRequestBodyBytes?: number;
  maxResponseBytes?: number;
  /** When true, Authorization/Cookie are treated as secret-bearing for redirect policy. */
  secretBearing?: boolean;
  timeoutMs?: number;
}

const headersToRecord = (headers: HeadersInit | undefined): Record<string, string> => {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  }
  return { ...headers };
};

const throwIfAborted = (signal: AbortSignal | null | undefined): void => {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    const error = new Error(typeof reason === 'string' ? reason : 'The operation was aborted');
    error.name = 'AbortError';
    throw error;
  }
};

/** Race one task against abort and remove the listener as soon as either settles. */
const raceWithAbort = async <T>(
  task: Promise<T>,
  signal: AbortSignal,
  onAbort?: () => void,
): Promise<T> => {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', handleAbort);
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      onAbort?.();
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    if (signal.aborted) handleAbort();
    task.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
};

const appendChunk = (
  chunks: Uint8Array[],
  total: number,
  value: Uint8Array,
  maxBytes: number,
): number => {
  const next = total + value.byteLength;
  if (next > maxBytes) {
    throw new TypeError(`Safe outbound adapter request body exceeds ${maxBytes} bytes`);
  }
  chunks.push(value);
  return next;
};

/**
 * Read a stream body with an absolute abort bound: each `reader.read()` races the
 * signal, and abort also cancels the reader so a stalled source cannot hang forever.
 */
const readStreamBody = async (
  body: ReadableStream<Uint8Array>,
  options: { maxBytes: number; signal?: AbortSignal | null },
): Promise<Buffer> => {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const signal = options.signal ?? null;

  try {
    for (;;) {
      throwIfAborted(signal);
      // Race the read against abort. reader.cancel() (from onAbort) may resolve
      // read() as { done: true } before abortPromise rejects — re-check signal.
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        const result = signal
          ? await raceWithAbort(reader.read(), signal, () => {
              void reader.cancel(signal.reason).catch(() => undefined);
            })
          : await reader.read();
        done = result.done;
        value = result.value;
      } catch (error) {
        throwIfAborted(signal);
        throw error;
      }
      throwIfAborted(signal);
      if (done) break;
      if (value) total = appendChunk(chunks, total, value, options.maxBytes);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be cancelled/released after abort.
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
};

const bodyToBuffer = async (
  body: BodyInit | null | undefined,
  options: { maxBytes: number; signal?: AbortSignal | null },
): Promise<Buffer | string | undefined> => {
  if (body == null) return undefined;
  throwIfAborted(options.signal);

  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > options.maxBytes) {
      throw new TypeError(`Safe outbound adapter request body exceeds ${options.maxBytes} bytes`);
    }
    return body;
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > options.maxBytes) {
      throw new TypeError(`Safe outbound adapter request body exceeds ${options.maxBytes} bytes`);
    }
    return Buffer.from(body);
  }
  if (body instanceof ArrayBuffer) {
    if (body.byteLength > options.maxBytes) {
      throw new TypeError(`Safe outbound adapter request body exceeds ${options.maxBytes} bytes`);
    }
    return Buffer.from(body);
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    if (body.size > options.maxBytes) {
      throw new TypeError(`Safe outbound adapter request body exceeds ${options.maxBytes} bytes`);
    }
    throwIfAborted(options.signal);
    if (options.signal) {
      return Buffer.from(await raceWithAbort(body.arrayBuffer(), options.signal));
    }
    return Buffer.from(await body.arrayBuffer());
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    const text = body.toString();
    if (Buffer.byteLength(text) > options.maxBytes) {
      throw new TypeError(`Safe outbound adapter request body exceeds ${options.maxBytes} bytes`);
    }
    return text;
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return readStreamBody(body, options);
  }
  // FormData and other exotic bodies are not used by admin connection tests.
  throw new TypeError('Unsupported request body type for safe outbound adapter');
};

interface ResolvedAdapterRequest {
  body?: Buffer | string;
  headers: Record<string, string>;
  method: string;
  url: string;
}

/**
 * Normalize RequestInfo/RequestInit into a plain outbound request.
 * `signal` is the adapter deadline signal (upstream abort is already forwarded into it)
 * and bounds body buffering.
 */
const resolveRequest = async (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  maxRequestBodyBytes: number,
  signal: AbortSignal,
): Promise<ResolvedAdapterRequest> => {
  if (typeof input === 'string' || input instanceof URL) {
    return {
      body: await bodyToBuffer(init?.body, { maxBytes: maxRequestBodyBytes, signal }),
      headers: headersToRecord(init?.headers),
      method: (init?.method ?? 'GET').toUpperCase(),
      url: input.toString(),
    };
  }

  const request = input;
  const mergedHeaders = headersToRecord(request.headers);
  Object.assign(mergedHeaders, headersToRecord(init?.headers));

  let body: Buffer | string | undefined;
  if (init?.body !== undefined) {
    body = await bodyToBuffer(init.body, { maxBytes: maxRequestBodyBytes, signal });
  } else if (request.body) {
    body = await bodyToBuffer(request.body, { maxBytes: maxRequestBodyBytes, signal });
  }

  return {
    body,
    headers: mergedHeaders,
    method: (init?.method ?? request.method ?? 'GET').toUpperCase(),
    url: request.url,
  };
};

/**
 * Build a fetch-compatible function that routes every hop through SafeOutboundHttpClient.
 *
 * Starts one absolute deadline **before** request normalization. Upstream abort is
 * forwarded into that same controller, and the controller signal is passed into body
 * buffering so a stalled stream cannot hang past `timeoutMs`. Remaining budget is
 * forwarded to the safe client.
 */
export const createSafeOutboundFetchAdapter = (
  client: SafeOutboundHttpClient,
  options: SafeOutboundFetchAdapterOptions = {},
): typeof fetch => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_ADAPTER_MAX_RESPONSE_BYTES;
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_ADAPTER_MAX_REQUEST_BODY_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_ADAPTER_MAX_REDIRECTS;
  const secretBearing = options.secretBearing ?? true;

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const deadlineAt = Date.now() + timeoutMs;
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => {
      deadlineController.abort(
        Object.assign(new Error('Safe outbound adapter deadline exceeded'), {
          name: 'TimeoutError',
        }),
      );
    }, timeoutMs);

    const upstreamSignal = (() => {
      if (typeof input === 'string' || input instanceof URL) return init?.signal ?? null;
      return init?.signal ?? (input as Request).signal ?? null;
    })();

    const onUpstreamAbort = () => {
      deadlineController.abort(upstreamSignal?.reason);
    };
    if (upstreamSignal) {
      if (upstreamSignal.aborted) onUpstreamAbort();
      else upstreamSignal.addEventListener('abort', onUpstreamAbort, { once: true });
    }

    try {
      // Deadline (with upstream abort forwarded) bounds normalization — not only the client hop.
      const resolved = await resolveRequest(
        input,
        init,
        maxRequestBodyBytes,
        deadlineController.signal,
      );
      const remainingMs = Math.max(1, deadlineAt - Date.now());
      const requestInit: SafeOutboundRequestInit = {
        body: resolved.body,
        headers: resolved.headers,
        maxRedirects,
        maxResponseBytes,
        method: resolved.method,
        secretBearing,
        signal: deadlineController.signal,
        timeoutMs: remainingMs,
      };

      try {
        const response = await client.fetch(resolved.url, requestInit);
        return new Response(new Uint8Array(response.body), {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        });
      } catch (error) {
        if (error instanceof SafeOutboundHttpError) {
          const wrapped = new Error(
            'Outbound request blocked by enterprise network policy',
          ) as Error & {
            status?: number;
          };
          wrapped.name = 'SafeOutboundFetchError';
          throw wrapped;
        }
        throw error;
      }
    } finally {
      clearTimeout(deadlineTimer);
      if (upstreamSignal) {
        upstreamSignal.removeEventListener('abort', onUpstreamAbort);
      }
    }
  }) as typeof fetch;
};
