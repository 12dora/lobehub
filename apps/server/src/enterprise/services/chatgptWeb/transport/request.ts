/**
 * fetch(input, init) → the flat shape the curl child process needs.
 * Deliberately narrow: only the body kinds the ChatGPT Web protocol actually sends.
 */
import { ChatGPTWebTransportPolicyError } from './errors';

/** curl computes these itself; a caller-supplied value would contradict the wire. */
const DROPPED_REQUEST_HEADERS = new Set(['accept-encoding', 'content-length']);

const HEADER_NAME = /^[!#$%&'*+\-.^\w`|~]+$/;
/** RFC 9110 method token; the same charset as a header name, kept short by construction. */
const METHOD_TOKEN = /^[!#$%&'*+\-.^\w`|~]{1,32}$/;

/**
 * Destination policy. This transport is a raw child process: nothing in the enterprise
 * SSRF stack can see it, so the ONE control is where it is allowed to point. The list is
 * the set of hosts the ChatGPT Web protocol actually talks to — chatgpt.com itself,
 * auth/sentinel on openai.com, the file-service download hosts, and the Azure blob
 * endpoints signed upload/download URLs resolve to.
 *
 * Deliberately NOT an IP check: the demo/on-prem deployments resolve chatgpt.com to a
 * fake-IP range (198.18/15) through a proxy resolver, so an address-based guard would
 * reject the very deployment this provider exists for. The hostname IS the control.
 */
const DEFAULT_ALLOWED_HOST_SUFFIXES = [
  'chatgpt.com',
  // covers auth.openai.com, sentinel.openai.com, api.openai.com, platform.openai.com
  'openai.com',
  'oaiusercontent.com',
  'oaistatic.com',
  'blob.core.windows.net',
] as const;

const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

export interface TransportRequestEnvironment {
  [key: string]: string | undefined;
  /** `1` allows plain http — for tests and a local mock backend, never for chatgpt.com. */
  CHATGPT_WEB_ALLOW_INSECURE_HTTP?: string | undefined;
  /** Comma-separated extra hostname suffixes. Operator escape hatch, opt-in only. */
  CHATGPT_WEB_ALLOWED_HOSTS?: string | undefined;
}

export interface NormalizedRequest {
  body?: Uint8Array;
  /** Header names rendered as curl `Name:` (delete the impersonate-profile leftover). */
  dropHeaders: string[];
  headers: [string, string][];
  method: string;
  signal?: AbortSignal;
  url: string;
}

export const createAbortError = (): DOMException =>
  new DOMException('The operation was aborted.', 'AbortError');

/**
 * C0-C1F + DEL, scanned by code point rather than by regex: these are exactly the bytes
 * that could forge an extra request line (in a header) or an extra option (in curl's
 * config file), so the check has to be unambiguous about which characters it covers.
 */
export const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index)!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const allowedHostSuffixes = (env: TransportRequestEnvironment): string[] => [
  ...DEFAULT_ALLOWED_HOST_SUFFIXES,
  ...(env.CHATGPT_WEB_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, ''))
    .filter((entry) => entry.length > 0),
];

const isAllowedHost = (hostname: string, suffixes: string[]): boolean => {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
};

/**
 * Destination validation. Every failure is a {@link ChatGPTWebTransportPolicyError} whose
 * message names the rule and the host — never the path, query or any credential material.
 */
export const validateRequestUrl = (
  raw: string,
  env: TransportRequestEnvironment = process.env,
): string => {
  // The WHATWG parser silently STRIPS tab/CR/LF, so a smuggled request line would survive
  // parsing and reach curl's config file. Reject on the raw string instead.
  if (hasControlCharacters(raw)) {
    throw new ChatGPTWebTransportPolicyError('request url contains control characters');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ChatGPTWebTransportPolicyError('request url is not absolute');
  }

  const insecureAllowed = env.CHATGPT_WEB_ALLOW_INSECURE_HTTP === '1';
  if (url.protocol !== 'https:' && !(insecureAllowed && url.protocol === 'http:')) {
    throw new ChatGPTWebTransportPolicyError(`unsupported url scheme "${url.protocol}"`);
  }
  if (url.username || url.password) {
    throw new ChatGPTWebTransportPolicyError('request url must not carry credentials');
  }
  if (!url.hostname) {
    throw new ChatGPTWebTransportPolicyError('request url has no host');
  }
  if (!isAllowedHost(url.hostname, allowedHostSuffixes(env))) {
    throw new ChatGPTWebTransportPolicyError(`destination host "${url.hostname}" is not allowed`);
  }

  return url.href;
};

export const validateRequestMethod = (method: string): string => {
  if (!METHOD_TOKEN.test(method)) {
    throw new ChatGPTWebTransportPolicyError('request method is not a valid HTTP token');
  }
  return method.toUpperCase();
};

const toBytes = (value: ArrayBuffer | ArrayBufferView): Uint8Array =>
  ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
    : new Uint8Array(value.slice(0));

/**
 * Drain a streaming body into memory.
 *
 * curl gets the body on stdin AFTER the child is spawned, so a stream must be
 * materialized first. That is a deliberate, documented limitation: every body this
 * protocol sends is a `Uint8Array` or a string already held in memory, and a `fetch`
 * caller handing over an unbounded stream would otherwise be able to exhaust the server.
 * Hence the hard cap and the abort wiring — an already-aborted or mid-flight-aborted
 * request cancels the reader instead of draining a stream nobody will ever use.
 */
const readStream = async (
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();

  const onAbort = () => {
    void reader.cancel(createAbortError()).catch(() => undefined);
  };
  if (signal?.aborted) {
    onAbort();
    throw createAbortError();
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ChatGPTWebTransportPolicyError(
          `request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte transport limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  // A cancelled reader ends the loop cleanly; the partial body must not be sent.
  if (signal?.aborted) throw createAbortError();

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
};

/**
 * curl streams the request body from stdin, so it is materialized here. Every body the
 * protocol sends (JSON envelopes, uploaded file bytes) is already bounded in memory;
 * `FormData` is rejected outright rather than silently mis-encoded.
 */
export const readRequestBody = async (
  body: BodyInit | null | undefined,
  headers: Headers,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> => {
  if (body === null || body === undefined) return undefined;

  if (typeof body === 'string') return new TextEncoder().encode(body);

  if (body instanceof URLSearchParams) {
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    }
    return new TextEncoder().encode(body.toString());
  }

  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    throw new TypeError(
      'ChatGPT Web transport does not support FormData request bodies; encode the multipart payload yourself.',
    );
  }

  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    if (body.type && !headers.has('content-type')) headers.set('content-type', body.type);
    return new Uint8Array(await body.arrayBuffer());
  }

  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return toBytes(body);

  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return readStream(body as ReadableStream<Uint8Array>, signal);
  }

  throw new TypeError('ChatGPT Web transport received an unsupported request body type.');
};

/**
 * Header injection guard. A CR/LF in a name or value would let a caller forge extra
 * request lines through curl's `--header` argument, so it is a hard error, not a strip.
 */
export const sanitizeRequestHeaders = (headers: Headers): [string, string][] => {
  const entries: [string, string][] = [];

  headers.forEach((value, name) => {
    if (/[\n\r]/.test(name) || /[\n\r]/.test(value)) {
      throw new TypeError(`Invalid header value for "${name}": CR/LF is not allowed.`);
    }
    const lower = name.toLowerCase();
    if (DROPPED_REQUEST_HEADERS.has(lower)) return;
    if (!HEADER_NAME.test(name)) throw new TypeError(`Invalid header name: "${name}".`);
    entries.push([name, value]);
  });

  return entries;
};

const mergeHeaders = (
  base: HeadersInit | undefined,
  override: HeadersInit | undefined,
): Headers => {
  const headers = new Headers(base ?? undefined);
  if (override) {
    for (const [name, value] of new Headers(override)) headers.set(name, value);
  }
  return headers;
};

export const normalizeRequest = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<NormalizedRequest> => {
  const source = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;

  // Signal FIRST: an already-aborted request must not drain a body or spawn anything.
  const signal = init?.signal ?? source?.signal ?? undefined;
  if (signal?.aborted) throw createAbortError();

  const url = validateRequestUrl(
    source ? source.url : input instanceof URL ? input.href : String(input),
  );
  const method = validateRequestMethod(init?.method ?? source?.method ?? 'GET');
  const headers = mergeHeaders(source?.headers, init?.headers);

  // A `Request` body is handed over as its STREAM, never drained with `arrayBuffer()`:
  // that would buffer an endless or oversized source outside the 64 MiB cap and keep
  // reading after an abort. `readRequestBody` applies both to every body kind alike.
  const rawBody = init && 'body' in init ? init.body : source?.body;

  const body = await readRequestBody(rawBody, headers, signal);
  const sanitized = sanitizeRequestHeaders(headers);
  const dropHeaders = sanitized.filter(([, value]) => value.length === 0).map(([name]) => name);
  const kept = sanitized.filter(([, value]) => value.length > 0);

  return {
    ...(body ? { body } : {}),
    dropHeaders,
    headers: kept,
    method,
    ...(signal ? { signal } : {}),
    url,
  };
};
