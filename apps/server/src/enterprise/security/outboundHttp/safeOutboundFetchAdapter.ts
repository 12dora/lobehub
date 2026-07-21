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

export interface SafeOutboundFetchAdapterOptions {
  maxRedirects?: number;
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

const bodyToBuffer = async (
  body: BodyInit | null | undefined,
): Promise<Buffer | string | undefined> => {
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return body.toString();
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  }
  // FormData and other exotic bodies are not used by admin connection tests.
  throw new TypeError('Unsupported request body type for safe outbound adapter');
};

const resolveRequest = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{
  headers: Record<string, string>;
  method: string;
  url: string;
  body?: Buffer | string;
}> => {
  if (typeof input === 'string' || input instanceof URL) {
    return {
      body: await bodyToBuffer(init?.body),
      headers: headersToRecord(init?.headers),
      method: (init?.method ?? 'GET').toUpperCase(),
      url: input.toString(),
    };
  }

  const request = input;
  const mergedHeaders = headersToRecord(request.headers);
  Object.assign(mergedHeaders, headersToRecord(init?.headers));
  const body =
    init?.body !== undefined
      ? await bodyToBuffer(init.body)
      : request.body
        ? Buffer.from(await request.arrayBuffer())
        : undefined;

  return {
    body,
    headers: mergedHeaders,
    method: (init?.method ?? request.method ?? 'GET').toUpperCase(),
    url: request.url,
  };
};

/**
 * Build a fetch-compatible function that routes every hop through SafeOutboundHttpClient.
 */
export const createSafeOutboundFetchAdapter = (
  client: SafeOutboundHttpClient,
  options: SafeOutboundFetchAdapterOptions = {},
): typeof fetch => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_ADAPTER_MAX_RESPONSE_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_ADAPTER_MAX_REDIRECTS;
  const secretBearing = options.secretBearing ?? true;

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const resolved = await resolveRequest(input, init);
    const requestInit: SafeOutboundRequestInit = {
      body: resolved.body,
      headers: resolved.headers,
      maxRedirects,
      maxResponseBytes,
      method: resolved.method,
      secretBearing,
      signal: init?.signal ?? null,
      timeoutMs,
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
  }) as typeof fetch;
};
