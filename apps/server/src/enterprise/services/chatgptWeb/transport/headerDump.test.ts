import { describe, expect, it } from 'vitest';

import { HeaderDumpReader } from './headerDump';

const feed = (...chunks: string[]) => {
  const reader = new HeaderDumpReader();
  let head;
  for (const chunk of chunks) head = reader.push(chunk) ?? head;
  return { head, reader };
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

    expect(reader.push('HTTP/2 200 \r\ncontent-')).toBeUndefined();
    const head = reader.push('type: text/event-stream\r\n\r\n');

    expect(head!.headers.get('content-type')).toBe('text/event-stream');
    // A trailing block (curl re-dumping, an alternate build) must not replace the head.
    expect(reader.push('HTTP/2 500 \r\n\r\n')).toBe(head);
    expect(reader.head).toBe(head);
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

    expect(reader.push('HTTP/2 200 \r\ncontent-type: application/json\r\n')).toBeUndefined();
    expect(reader.head).toBeUndefined();
  });
});
