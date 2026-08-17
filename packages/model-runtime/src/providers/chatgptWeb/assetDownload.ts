/**
 * Bounded download of ChatGPT Web attachments. SSRF-safe on the server, plain
 * fetch in the browser bundle. Never interpolates a signed URL into a log or
 * error message — only the host is surfaced.
 */

import createDebug from 'debug';

import { MAX_DOWNLOAD_BYTES, readBoundedBody } from './client';
import { isCallerAbort } from './errors';
import { isAbortError } from './turnHelpers';

const log = createDebug('lobe-chatgptweb:runtime');

export const extensionFor = (mimeType: string): string => {
  const subtype = mimeType.split('/')[1] ?? 'bin';
  return subtype === 'jpeg' ? 'jpg' : subtype.split('+')[0];
};

/** Never log a signed asset URL: the query string carries the credential. */
const urlHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '<unparseable url>';
  }
};

/**
 * Download an attachment referenced by URL. SSRF-safe on the server, plain fetch
 * in the browser bundle.
 *
 * Bounded in both directions: an announced `Content-Length` over the ceiling is
 * refused before a byte is read, and the body itself is streamed through
 * {@link readBoundedBody} so a chunked/endless response cannot exhaust the
 * process either.
 */
export const fetchBytes = async (
  url: string,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; mimeType?: string }> => {
  const isServer = typeof window === 'undefined';

  // `maxContentLength` soft-truncates one byte past the ceiling, which is what
  // lets `readBoundedBody` below tell "at the limit" from "over it".
  // TODO: `ssrfSafeFetch` console.errors its own caught fetch errors verbatim
  // (shared package). Nothing here can suppress that; fix it at the source.
  let response: Response;
  try {
    response = isServer
      ? await import('@lobechat/ssrf-safe-fetch').then((module) =>
          module.ssrfSafeFetch(url, { signal }, { maxContentLength: MAX_DOWNLOAD_BYTES + 1 }),
        )
      : await globalThis.fetch(url, { signal });
  } catch (error) {
    // the caller pressing stop keeps its own AbortError semantics
    if (isAbortError(error) || isCallerAbort(signal)) throw error;
    // host + error class only — a signed URL's query string IS the credential
    log('asset fetch failed: host=%s error=%s', urlHost(url), (error as Error)?.name ?? 'Error');
    // the MESSAGE carries the host only; the original stays on `cause`, which is
    // non-enumerable and therefore never lands in a serialized payload
    throw new Error(`failed to download attachment from ${urlHost(url)}`, { cause: error });
  }

  if (!response.ok)
    throw new Error(
      `failed to download attachment from ${urlHost(url)}: status=${response.status}`,
    );

  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES)
    throw new Error(
      `attachment from ${urlHost(url)} is ${declared} bytes, over the ${MAX_DOWNLOAD_BYTES} byte limit`,
    );

  return {
    bytes: await readBoundedBody(response, MAX_DOWNLOAD_BYTES),
    mimeType: response.headers.get('content-type') ?? undefined,
  };
};

/** A data URI's decoded size, bounded before it is ever materialised. */
export const assertBoundedBase64 = (base64: string, what: string): void => {
  // 4 base64 chars ⇒ 3 bytes; compare on the ENCODED length so nothing is decoded first
  if (base64.length / 4 > MAX_DOWNLOAD_BYTES / 3)
    throw new Error(`inline ${what} exceeds the ${MAX_DOWNLOAD_BYTES} byte limit`);
};
