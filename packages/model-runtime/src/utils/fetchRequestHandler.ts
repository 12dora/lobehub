/**
 * AWS SDK / Smithy requestHandler that routes every hop through a WHATWG fetch
 * implementation (e.g. SafeOutbound-backed). Used by Bedrock connection tests.
 *
 * Node stream is loaded dynamically so the module top-level stays browser-safe
 * for SPA bundles that re-export @lobechat/model-runtime (server-only at runtime).
 */
import type { Readable } from 'node:stream';

import type { FetchLike } from './boundFetch';
import {
  bodyForHttpMethod,
  composeAbortSignal,
  normalizeFetchBody,
  responseHeadersToRecord,
} from './fetchTransport';

export interface AwsSdkHttpRequest {
  body?: unknown;
  headers?: Record<string, string>;
  hostname: string;
  method: string;
  path: string;
  port?: number;
  protocol: string;
  query?: Record<string, string | Array<string> | null | undefined>;
}

export interface AwsSdkHttpResponse {
  body: Readable;
  headers: Record<string, string>;
  statusCode: number;
}

const buildUrl = (request: AwsSdkHttpRequest): string => {
  const port =
    request.port && request.port !== 80 && request.port !== 443 ? `:${request.port}` : '';
  const base = `${request.protocol}//${request.hostname}${port}${request.path}`;
  if (!request.query || Object.keys(request.query).length === 0) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, value);
    }
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
};

export interface AwsSdkHttpHandlerOptions {
  abortSignal?: AbortSignal;
  requestTimeout?: number;
}

/**
 * Minimal Smithy-compatible request handler. Accepts a fetch implementation so
 * Bedrock never falls back to the default Node HTTP stack during enterprise probes.
 * Propagates Smithy abortSignal / requestTimeout without leaving timer listeners.
 */
export const createFetchRequestHandler = (fetchImpl: FetchLike) => {
  return {
    destroy: () => undefined,
    handle: async (
      request: AwsSdkHttpRequest,
      options?: AwsSdkHttpHandlerOptions,
    ): Promise<{ response: AwsSdkHttpResponse }> => {
      if (options?.abortSignal?.aborted) {
        const error = new Error('Request aborted') as Error & { name: string };
        error.name = 'AbortError';
        throw error;
      }

      const url = buildUrl(request);
      const headers: Record<string, string> = { ...request.headers };
      const body = bodyForHttpMethod(request.method, await normalizeFetchBody(request.body));
      const { cleanup, signal } = composeAbortSignal(options?.abortSignal, options?.requestTimeout);

      try {
        const response = await fetchImpl(url, {
          body,
          headers,
          method: request.method,
          signal,
        });
        const arrayBuffer = await response.arrayBuffer();
        // Dynamic import: static `import { Readable } from 'node:stream'` fails SPA
        // production builds (rolldown node-stub has no Readable named export).
        const { Readable } = await import('node:stream');
        return {
          response: {
            body: Readable.from([Buffer.from(arrayBuffer)]),
            headers: responseHeadersToRecord(response.headers),
            statusCode: response.status,
          },
        };
      } catch (error) {
        if (signal.aborted) {
          const aborted = new Error('Request aborted') as Error & { name: string };
          aborted.name = 'AbortError';
          throw aborted;
        }
        throw error;
      } finally {
        cleanup();
      }
    },
    httpHandlerConfigs: () => ({}),
    updateHttpClientConfig: () => undefined,
  };
};
