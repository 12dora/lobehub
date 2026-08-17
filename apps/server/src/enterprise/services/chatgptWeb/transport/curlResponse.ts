import type { ParsedHeaderBlock } from './headerDump';

/** Statuses whose response is defined to have no body (Response would throw). */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

const attachUrl = (response: Response, url: string): Response => {
  try {
    Object.defineProperty(response, 'url', { configurable: true, value: url });
  } catch {
    // Some runtimes seal Response; the url is cosmetic for our consumers.
  }
  return response;
};

export const buildResponse = (
  head: ParsedHeaderBlock,
  body: ReadableStream<Uint8Array> | null,
  url: string,
) =>
  attachUrl(
    new Response(NULL_BODY_STATUS.has(head.status) ? null : body, {
      headers: head.headers,
      status: head.status,
      statusText: head.statusText,
    }),
    url,
  );
