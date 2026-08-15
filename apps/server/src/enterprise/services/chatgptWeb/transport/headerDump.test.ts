import { describe, expect, it } from 'vitest';

import { HeaderDumpReader } from './headerDump';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const feed = (...chunks: string[]) => {
  const reader = new HeaderDumpReader();
  let split;
  for (const chunk of chunks) split = reader.push(encode(chunk)) ?? split;
  return { body: split?.body, head: split?.head, reader };
};

describe('HeaderDumpReader', () => {
  it('parses an HTTP/2 head with no reason phrase', () => {
    const { head } = feed('HTTP/2 200 \r\ncontent-type: application/json\r\n\r\n');

    expect(head).toMatchObject({ status: 200, statusText: '' });
    expect(head!.headers.get('content-type')).toBe('application/json');
  });

  it('drops hop-by-hop and stale transfer headers', () => {
    const { head } = feed(
      'HTTP/1.1 200 OK\r\ncontent-encoding: gzip\r\ncontent-length: 42\r\ntransfer-encoding: chunked\r\nconnection: keep-alive\r\nx-keep: yes\r\n\r\n',
    );

    expect(head!.headers.get('content-encoding')).toBeNull();
    expect(head!.headers.get('content-length')).toBeNull();
    expect(head!.headers.get('transfer-encoding')).toBeNull();
    expect(head!.headers.get('connection')).toBeNull();
    expect(head!.headers.get('x-keep')).toBe('yes');
  });

  it('skips several informational blocks', () => {
    const { head } = feed(
      'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nlink: </a.css>\r\n\r\nHTTP/2 201 \r\nx-real: yes\r\n\r\n',
    );

    expect(head).toMatchObject({ status: 201 });
    expect(head!.headers.get('link')).toBeNull();
    expect(head!.headers.get('x-real')).toBe('yes');
  });

  /**
   * The bug this guards: a proxy's tunnel answer was accepted as the origin response, so
   * every request through a CONNECT proxy could resolve as a fabricated, empty 200.
   */
  it('skips a proxy CONNECT-established block', () => {
    const { head } = feed(
      'HTTP/1.1 200 Connection established\r\nProxy-Agent: squid/5.7\r\n\r\nHTTP/2 401 \r\nwww-authenticate: Bearer\r\n\r\n',
    );

    expect(head).toMatchObject({ status: 401 });
    expect(head!.headers.get('www-authenticate')).toBe('Bearer');
  });

  /**
   * The regression this guards: "a 2xx carrying only proxy-ish headers is a tunnel" also
   * matched every header-less HTTP/1.x response — `[].every()` is true — so a real
   * `HTTP/1.1 204` was skipped and the request died with "no response headers were
   * received". Only the `Connection established` reason phrase marks a CONNECT answer.
   */
  it('accepts a bare HTTP/1.1 204 origin response', () => {
    const { head } = feed('HTTP/1.1 204 No Content\r\n\r\n');

    expect(head).toMatchObject({ status: 204, statusText: 'No Content' });
  });

  it('accepts an HTTP/1.1 origin response that carries only Connection/Via', () => {
    const { head } = feed('HTTP/1.1 200 OK\r\nvia: 1.1 gateway\r\nconnection: close\r\n\r\n');

    expect(head).toMatchObject({ status: 200 });
    // Still hop-by-hop: dropped from the Response, but no longer a reason to skip the block.
    expect(head!.headers.get('connection')).toBeNull();
    expect(head!.headers.get('via')).toBe('1.1 gateway');
  });

  it('accepts a header-less HTTP/1.1 200 with no reason phrase', () => {
    const { head } = feed('HTTP/1.1 200 \r\n\r\n');

    expect(head).toMatchObject({ status: 200 });
  });

  it('never mistakes an HTTP/2 origin head for a tunnel block', () => {
    // Same status, no reason phrase, no headers — but HTTP/2 is never a CONNECT answer.
    const { head } = feed('HTTP/2 200 \r\n\r\n');

    expect(head).toMatchObject({ status: 200 });
  });

  it('resolves across chunk boundaries and then stays stable', () => {
    const reader = new HeaderDumpReader();

    expect(reader.push(encode('HTTP/2 200 \r\ncontent-'))).toBeUndefined();
    const split = reader.push(encode('type: text/event-stream\r\n\r\n'));

    expect(split!.head.headers.get('content-type')).toBe('text/event-stream');
    expect(split!.body).toHaveLength(0);
    // Everything after the head is body, verbatim — even bytes that look like a header
    // block (curl re-dumping, an alternate build) must not replace the head.
    const later = reader.push(encode('HTTP/2 500 \r\n\r\n'));
    expect(later!.head).toBe(split!.head);
    expect(decode(later!.body)).toBe('HTTP/2 500 \r\n\r\n');
    expect(reader.head).toBe(split!.head);
  });

  /**
   * With `--dump-header -` the head and the body share stdout, so the first body bytes
   * routinely arrive in the same chunk that completes the head.
   */
  it('returns the body bytes that follow the head in the same chunk', () => {
    const { head, body } = feed('HTTP/2 200 \r\ncontent-type: text/plain\r\n\r\nhello world');

    expect(head).toMatchObject({ status: 200 });
    expect(decode(body!)).toBe('hello world');
  });

  it('keeps the body intact when the terminator is split across chunks', () => {
    const reader = new HeaderDumpReader();

    expect(reader.push(encode('HTTP/2 200 \r\nx: 1\r\n\r'))).toBeUndefined();
    const split = reader.push(encode('\ndata: one\n\n'));

    expect(split!.head).toMatchObject({ status: 200 });
    expect(decode(split!.body)).toBe('data: one\n\n');
  });

  it('passes binary body bytes through untouched', () => {
    const reader = new HeaderDumpReader();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
    const header = encode('HTTP/2 200 \r\ncontent-type: image/png\r\n\r\n');
    const chunk = new Uint8Array(header.length + png.length);
    chunk.set(header);
    chunk.set(png, header.length);

    const split = reader.push(chunk);

    expect(split!.head.headers.get('content-type')).toBe('image/png');
    expect([...split!.body]).toEqual([...png]);
  });

  it('skips a pre-block and still returns only the body after the real head', () => {
    const { head, body } = feed(
      'HTTP/1.1 100 Continue\r\n\r\nHTTP/2 200 \r\nx: 1\r\n\r\n{"ok":true}',
    );

    expect(head).toMatchObject({ status: 200 });
    expect(decode(body!)).toBe('{"ok":true}');
  });

  it('refuses to buffer an unterminated header block forever', () => {
    const reader = new HeaderDumpReader();
    const filler = encode(`x-pad: ${'a'.repeat(256 * 1024)}\r\n`);

    expect(reader.push(encode('HTTP/2 200 \r\n'))).toBeUndefined();
    expect(() => {
      for (let i = 0; i < 8; i += 1) reader.push(filler);
    }).toThrow(/header block exceeds/);
  });

  it('ignores malformed blocks and continues to the real head', () => {
    const { head } = feed('not a status line\r\nx: 1\r\n\r\nHTTP/2 204 \r\n\r\n');

    expect(head).toMatchObject({ status: 204 });
  });

  it('joins obs-fold continuation lines', () => {
    const { head } = feed('HTTP/1.1 200 OK\r\nx-long: first\r\n  second\r\n\r\n');

    expect(head!.headers.get('x-long')).toBe('first second');
  });

  it('reports no head until a block is terminated', () => {
    const reader = new HeaderDumpReader();

    expect(
      reader.push(encode('HTTP/2 200 \r\ncontent-type: application/json\r\n')),
    ).toBeUndefined();
    expect(reader.head).toBeUndefined();
  });
});
