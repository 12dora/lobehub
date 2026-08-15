/**
 * Parser for curl's `--dump-header -` output, which curl writes to STDOUT immediately
 * ahead of the response body.
 *
 * The dump can contain SEVERAL blocks: `HTTP/1.1 100 Continue`, `HTTP/1.1 103 Early
 * Hints`, a proxy's `HTTP/1.1 200 Connection established` CONNECT answer, and — with
 * HTTP/2 — a status line that carries no reason phrase at all (`HTTP/2 200 `). Only the
 * first block that is none of those describes the response we hand back; anything after
 * its terminating blank line is body.
 *
 * The reader therefore works on BYTES, not on a decoded string: the body may be binary
 * (an image download), the terminator may straddle two chunks, and the first body bytes
 * routinely arrive in the same chunk as the head. Header text is decoded as `latin1`,
 * which maps one byte to one code unit, so string offsets are byte offsets.
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
 * Guard against an origin (or a broken proxy) that never terminates its header block:
 * without a cap the reader would buffer the whole response in memory while still
 * reporting "no headers yet". curl's own limit per response header is 100 KiB.
 */
const MAX_HEADER_BYTES = 1024 * 1024;

const EMPTY = new Uint8Array(0);

export class HeaderDumpTooLargeError extends Error {
  constructor() {
    super(`response header block exceeds the ${MAX_HEADER_BYTES}-byte limit`);
    this.name = 'HeaderDumpTooLargeError';
  }
}

export interface HeaderDumpSplit {
  /** Bytes of THIS chunk that belong to the body (empty when the chunk was all header). */
  body: Uint8Array;
  head: ParsedHeaderBlock;
}

/**
 * Incremental reader: feed raw stdout chunks, get the response head as soon as its
 * terminating blank line has arrived (so a streaming response resolves on its first
 * byte) together with the body bytes that followed it in the same chunk.
 */
export class HeaderDumpReader {
  private buffer: Buffer = Buffer.alloc(0);
  private result: ParsedHeaderBlock | undefined;

  /**
   * @returns the head plus this chunk's body bytes once the head is complete; undefined
   * while the header block is still incomplete. Once the head has been found every later
   * chunk is pure body and is returned unchanged.
   */
  push(chunk: Uint8Array): HeaderDumpSplit | undefined {
    if (this.result) return { body: chunk, head: this.result };

    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      // latin1: one byte per code unit, so a string index IS a byte offset.
      const text = this.buffer.toString('latin1');
      const separator = /\r?\n\r?\n/.exec(text);
      if (!separator) {
        if (this.buffer.length > MAX_HEADER_BYTES) throw new HeaderDumpTooLargeError();
        return undefined;
      }

      const block = text.slice(0, separator.index);
      const consumed = separator.index + separator[0].length;
      const parsed = parseBlock(block);

      // Skip everything that precedes the origin's own head: informational (1xx) blocks
      // and the proxy's CONNECT-established block. Redirects are never followed, so the
      // first block that is neither IS the last one — settling here (rather than waiting
      // for EOF) is what lets a streaming response resolve on its first byte.
      if (parsed && parsed.status >= 200 && !parsed.connectEstablished) {
        const { connectEstablished: _connect, ...head } = parsed;
        this.result = head;
        // Copy the tail off the header buffer so the buffer itself can be released.
        const body = new Uint8Array(this.buffer.subarray(consumed));
        this.buffer = Buffer.alloc(0);
        return { body: body.byteLength > 0 ? body : EMPTY, head };
      }

      this.buffer = this.buffer.subarray(consumed);
    }
  }

  get head(): ParsedHeaderBlock | undefined {
    return this.result;
  }
}
