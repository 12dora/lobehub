/**
 * AWS SDK / Smithy requestHandler that routes every hop through a WHATWG fetch
 * implementation (e.g. SafeOutbound-backed). Used by Bedrock connection tests.
 */
import { Readable } from 'node:stream';

import type { FetchLike } from './boundFetch';

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

const bodyToInit = async (body: unknown): Promise<BodyInit | undefined> => {
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new Uint8Array(body);
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  if (typeof body === 'object' && body !== null && Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<unknown>) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk)));
    }
    const total = chunks.reduce((sum, part) => sum + part.byteLength, 0);
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

/**
 * Minimal Smithy-compatible request handler. Accepts a fetch implementation so
 * Bedrock never falls back to the default Node HTTP stack during enterprise probes.
 */
export const createFetchRequestHandler = (fetchImpl: FetchLike) => {
  return {
    destroy: () => undefined,
    handle: async (request: AwsSdkHttpRequest): Promise<{ response: AwsSdkHttpResponse }> => {
      const url = buildUrl(request);
      const headers: Record<string, string> = { ...request.headers };
      const body = await bodyToInit(request.body);
      const response = await fetchImpl(url, {
        body: body && request.method !== 'GET' && request.method !== 'HEAD' ? body : undefined,
        headers,
        method: request.method,
      });
      const arrayBuffer = await response.arrayBuffer();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      return {
        response: {
          body: Readable.from([Buffer.from(arrayBuffer)]),
          headers: responseHeaders,
          statusCode: response.status,
        },
      };
    },
    httpHandlerConfigs: () => ({}),
    updateHttpClientConfig: () => undefined,
  };
};
