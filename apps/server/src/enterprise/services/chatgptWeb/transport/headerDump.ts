/**
 * Parser for curl's `--dump-header` output (written to an extra stdio fd so it never
 * mixes with the response body on stdout).
 *
 * The dump can contain SEVERAL blocks: `HTTP/1.1 100 Continue`, `HTTP/1.1 103 Early
 * Hints`, a proxy's `HTTP/1.1 200 Connection established` CONNECT answer, and — with
 * HTTP/2 — a status line that carries no reason phrase at all (`HTTP/2 200 `). Only the
 * first block that is none of those describes the response we hand back; anything after
 * it is ignored (redirects are never followed).
 */

/** Hop-by-hop / transport-encoding headers: curl already decoded the body for us. */
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'transfer-encoding',
]);

const STATUS_LINE = /^HTTP\/([\d.]+)\s+(\d{3})(?:\s(.*))?$/i;

export interface ParsedHeaderBlock {
  headers: Headers;
  status: number;
  statusText: string;
}

interface RawHeaderBlock extends ParsedHeaderBlock {
  /** `HTTP/1.1 200 Connection established` — the proxy tunnel, not the origin. */
  connectEstablished: boolean;
}

const parseBlock = (block: string): RawHeaderBlock | undefined => {
  const lines = block.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;

  const statusMatch = STATUS_LINE.exec(lines[0].trim());
  if (!statusMatch) return undefined;

  const httpVersion = statusMatch[1];
  const status = Number(statusMatch[2]);
  const statusText = (statusMatch[3] ?? '').trim();

  const headers = new Headers();
  let lastName: string | undefined;

  for (const line of lines.slice(1)) {
    // obs-fold continuation: append to the previous field value.
    if (/^[\t ]/.test(line) && lastName) {
      const previous = headers.get(lastName) ?? '';
      try {
        headers.set(lastName, `${previous} ${line.trim()}`);
      } catch {
        // Malformed continuation — drop it rather than failing the whole response.
      }
      continue;
    }

    const separator = line.indexOf(':');
    if (separator <= 0) continue;

    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!name) continue;
    if (DROPPED_RESPONSE_HEADERS.has(name)) continue;

    try {
      headers.append(name, value);
      lastName = name;
    } catch {
      // Origin-controlled header names can be invalid; never fail the response for one.
    }
  }

  // A CONNECT tunnel answers `HTTP/1.1 200 Connection established` (curl only emits it
  // without `--suppress-connect-headers`, and an alternate curl build may emit it anyway).
  // Treating it as the origin head hands the caller a fabricated 200 with an empty body.
  //
  // The REASON PHRASE is the whole test. Inferring the tunnel from "carries only
  // proxy-ish headers" swallowed real origin responses: `HTTP/1.1 204 No Content` has no
  // headers at all (and `[].every()` is true), and a bare `HTTP/1.1 200` answering with
  // just `Connection`/`Via` is an ordinary origin response behind a gateway. Both were
  // skipped, and the request then failed with "no response headers were received".
  const connectEstablished =
    httpVersion.startsWith('1') &&
    status >= 200 &&
    status < 300 &&
    /connection established/i.test(statusText);

  return { connectEstablished, headers, status, statusText };
};

/**
 * Incremental reader: feed raw fd3 chunks, get the final response head as soon as its
 * terminating blank line has arrived (so streaming responses resolve on first byte).
 */
export class HeaderDumpReader {
  private buffer = '';
  private result: ParsedHeaderBlock | undefined;

  /** @returns the response head once it is complete, otherwise undefined. */
  push(chunk: string): ParsedHeaderBlock | undefined {
    if (this.result) return this.result;

    this.buffer += chunk;

    for (;;) {
      const end = this.buffer.search(/\r?\n\r?\n/);
      if (end === -1) return undefined;

      const block = this.buffer.slice(0, end);
      const separator = /\r?\n\r?\n/.exec(this.buffer.slice(end))![0];
      this.buffer = this.buffer.slice(end + separator.length);

      const parsed = parseBlock(block);
      // Skip everything that precedes the origin's own head: informational (1xx) blocks
      // and the proxy's CONNECT-established block. Redirects are never followed, so the
      // first block that is neither IS the last one — settling here (rather than waiting
      // for EOF) is what lets a streaming response resolve on its first byte.
      if (parsed && parsed.status >= 200 && !parsed.connectEstablished) {
        const { connectEstablished: _connect, ...head } = parsed;
        this.result = head;
        return head;
      }
    }
  }

  get head(): ParsedHeaderBlock | undefined {
    return this.result;
  }
}
