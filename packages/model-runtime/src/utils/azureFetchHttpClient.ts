/**
 * Azure pipeline HttpClient backed by a WHATWG fetch implementation.
 * Matches @azure/core-rest-pipeline / @typespec/ts-http-runtime HttpClient so
 * AzureAI never uses the default Node HTTP stack when a custom fetch is supplied.
 */
import type { FetchLike } from './boundFetch';
import {
  bodyForHttpMethod,
  composeAbortSignal,
  normalizeFetchBody,
  responseHeadersToRecord,
} from './fetchTransport';

/** Azure HttpHeaders is Iterable<[string, string]> with toJSON — not DOM Headers.forEach. */
interface AzureRequestHeaders {
  [Symbol.iterator]?: () => Iterator<[string, string]>;
  forEach?: (callback: (value: string, key: string) => void) => void;
  get?: (name: string) => string | undefined;
  toJSON?: (options?: { preserveCase?: boolean }) => Record<string, string>;
}

interface AzurePipelineRequest {
  abortSignal?: AbortSignal;
  body?: unknown;
  headers: AzureRequestHeaders;
  method: string;
  timeout?: number;
  url: string;
}

interface AzureResponseHeaders {
  [Symbol.iterator]: () => Iterator<[string, string]>;
  delete: (name: string) => void;
  get: (name: string) => string | undefined;
  has: (name: string) => boolean;
  set: (name: string, value: string | number | boolean) => void;
  toJSON: (options?: { preserveCase?: boolean }) => Record<string, string>;
}

export interface AzureHttpClient {
  sendRequest: (request: AzurePipelineRequest) => Promise<{
    bodyAsText?: string;
    headers: AzureResponseHeaders;
    request: AzurePipelineRequest;
    status: number;
  }>;
}

const headersToRecord = (headers: AzureRequestHeaders): Record<string, string> => {
  if (typeof headers.toJSON === 'function') {
    return headers.toJSON({ preserveCase: true });
  }
  const out: Record<string, string> = {};
  if (typeof headers[Symbol.iterator] === 'function') {
    for (const [key, value] of headers as Iterable<[string, string]>) {
      out[key] = value;
    }
    return out;
  }
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      out[key] = value;
    });
  }
  return out;
};

const createHeadersBag = (initial?: Record<string, string>): AzureResponseHeaders => {
  const map = new Map<string, { name: string; value: string }>();
  if (initial) {
    for (const [name, value] of Object.entries(initial)) {
      map.set(name.toLowerCase(), { name, value });
    }
  }
  return {
    delete: (name) => {
      map.delete(name.toLowerCase());
    },
    get: (name) => map.get(name.toLowerCase())?.value,
    has: (name) => map.has(name.toLowerCase()),
    set: (name, value) => {
      map.set(name.toLowerCase(), { name, value: String(value) });
    },
    toJSON: (options = {}) => {
      const result: Record<string, string> = {};
      for (const [normalized, entry] of map) {
        result[options.preserveCase ? entry.name : normalized] = entry.value;
      }
      return result;
    },
    [Symbol.iterator]: function* () {
      for (const entry of map.values()) {
        yield [entry.name, entry.value];
      }
    },
  };
};

/**
 * Build an Azure HttpClient that routes every hop through `fetchImpl`.
 */
export const createAzureFetchHttpClient = (fetchImpl: FetchLike): AzureHttpClient => ({
  sendRequest: async (request) => {
    if (request.abortSignal?.aborted) {
      const error = new Error('The operation was aborted.') as Error & { name: string };
      error.name = 'AbortError';
      throw error;
    }

    const headers = headersToRecord(request.headers);
    const { cleanup, signal } = composeAbortSignal(request.abortSignal, request.timeout);

    try {
      const body = bodyForHttpMethod(request.method, await normalizeFetchBody(request.body));
      const response = await fetchImpl(request.url, {
        body,
        headers,
        method: request.method,
        signal,
      });
      const text = await response.text();
      return {
        bodyAsText: text,
        headers: createHeadersBag(responseHeadersToRecord(response.headers)),
        request,
        status: response.status,
      };
    } finally {
      cleanup();
    }
  },
});
