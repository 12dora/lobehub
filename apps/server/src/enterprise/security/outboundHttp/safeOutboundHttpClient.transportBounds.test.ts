// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { SafeOutboundHttpClient } from './index';

describe('defaultPinnedTransport body / deadline bounds (MAJOR-1)', () => {
  it('stops reading when response exceeds maxResponseBytes and does not buffer unbounded', async () => {
    const http = await import('node:http');
    const { defaultPinnedTransport } = await import('./transport');

    let clientAborted = false;
    const chunk = Buffer.alloc(32 * 1024, 0x62); // 32 KiB
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      let writes = 0;
      const pump = () => {
        // Attempt to stream far more than the client cap (would OOM if buffered unboundedly).
        while (writes < 400) {
          writes += 1;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      req.on('aborted', () => {
        clientAborted = true;
      });
      res.on('close', () => {
        if (!res.writableFinished) clientAborted = true;
      });
      pump();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected TCP address');
    const port = addr.port;

    try {
      const maxResponseBytes = 50_000; // ~50 KiB
      const result = await defaultPinnedTransport({
        family: 4,
        headers: {},
        maxResponseBytes,
        method: 'GET',
        pinnedAddress: '127.0.0.1',
        timeoutMs: 5_000,
        url: new URL(`http://127.0.0.1:${port}/flood`),
      });

      expect(result.body.length).toBeLessThanOrEqual(maxResponseBytes);
      expect(result.body.length).toBe(maxResponseBytes);
      expect(result.truncated).toBe(true);
      // Connection should have been torn down (abort/close before full write).
      // Give the event loop a tick for 'close'/'aborted'.
      await new Promise((r) => setTimeout(r, 50));
      expect(clientAborted || result.truncated).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('SafeOutboundHttpClient default transport enforces maxResponseBytes end-to-end', async () => {
    const http = await import('node:http');

    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      // ~200 KiB of body
      res.end(Buffer.alloc(200 * 1024, 0x63));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected TCP address');
    const port = addr.port;

    try {
      const client = new SafeOutboundHttpClient({
        mode: 'allow-private',
        maxResponseBytes: 8_192,
        timeoutMs: 5_000,
      });
      const res = await client.fetch(`http://127.0.0.1:${port}/`);
      expect(res.body.length).toBeLessThanOrEqual(8_192);
      expect(res.truncated).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
