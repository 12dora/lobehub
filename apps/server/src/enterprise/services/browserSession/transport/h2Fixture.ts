/**
 * Local HTTP/2 fixture for C3 transport tests. Test-only localhost cert.
 */
import { readFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import {
  createSecureServer,
  type Http2SecureServer,
  type Http2Session,
  type ServerHttp2Stream,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const H2_CERT_PATH = path.join(FIXTURE_DIR, 'fixtures', 'localhost-cert.pem');
export const H2_KEY_PATH = path.join(FIXTURE_DIR, 'fixtures', 'localhost-key.pem');

export interface CapturedH2Request {
  body: Buffer;
  headers: IncomingHttpHeaders;
  url: string;
}

export interface H2Fixture {
  captured: CapturedH2Request[];
  close: () => Promise<void>;
  concurrentMax: number;
  origin: string;
  port: number;
  sessionCloses: number;
  sessions: number;
  url: (path: string) => string;
  waitForSessionClose: (previous: number, timeoutMs?: number) => Promise<void>;
}

export interface StartH2FixtureOptions {
  onStream?: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => boolean | void;
}

const readStreamBody = (stream: ServerHttp2Stream): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });

export const startH2Fixture = async (options: StartH2FixtureOptions = {}): Promise<H2Fixture> => {
  const captured: CapturedH2Request[] = [];
  let sessions = 0;
  let sessionCloses = 0;
  let concurrent = 0;
  let concurrentMax = 0;
  const liveSessions = new Set<Http2Session>();

  const server: Http2SecureServer = createSecureServer({
    cert: readFileSync(H2_CERT_PATH),
    key: readFileSync(H2_KEY_PATH),
  });

  server.on('session', (session) => {
    sessions += 1;
    liveSessions.add(session);
    session.on('close', () => {
      sessionCloses += 1;
      liveSessions.delete(session);
    });
  });

  server.on('stream', (stream, headers) => {
    concurrent += 1;
    concurrentMax = Math.max(concurrentMax, concurrent);
    stream.on('close', () => {
      concurrent -= 1;
    });

    if (options.onStream?.(stream, headers)) return;

    const path = String(headers[':path'] ?? '/');
    void (async () => {
      const body = await readStreamBody(stream);
      captured.push({ body, headers, url: path });

      if (path.startsWith('/hang')) {
        // Never write a response so CURLOPT_TIMEOUT_MS fails before the head.
        return;
      }

      if (path.startsWith('/slow')) {
        stream.respond({ ':status': 200, 'content-type': 'text/plain' });
        stream.write('chunk-one\n');
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (!stream.closed) stream.end('chunk-two\n');
        return;
      }

      if (path.startsWith('/large') || path.startsWith('/flood')) {
        stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        const limit = path.startsWith('/flood') ? Number.POSITIVE_INFINITY : 32;
        for (let index = 0; index < limit; index += 1) {
          if (stream.closed) return;
          if (!stream.write(chunk)) {
            await new Promise((resolve) => stream.once('drain', resolve));
          }
        }
        if (!stream.closed && Number.isFinite(limit)) stream.end();
        return;
      }

      if (path.startsWith('/continue')) {
        stream.additionalHeaders({ ':status': 100 });
        stream.respond({ ':status': 200, 'content-type': 'application/json' });
        stream.end('{"continued":true}');
        return;
      }

      if (path.startsWith('/slow-set-cookie')) {
        const query = path.includes('?') ? new URL(path, 'https://localhost').searchParams : null;
        const name = query?.get('n') ?? 'token';
        stream.respond({
          ':status': 200,
          'content-type': 'text/plain',
          'set-cookie': `${name}=from-server; Path=/`,
        });
        stream.write('chunk-one\n');
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (!stream.closed) stream.end('chunk-two\n');
        return;
      }

      if (path.startsWith('/set-cookie')) {
        const query = path.includes('?') ? new URL(path, 'https://localhost').searchParams : null;
        const name = query?.get('n') ?? 'c3test';
        stream.respond({
          ':status': 200,
          'content-type': 'text/plain',
          'set-cookie': `${name}=1; Path=/`,
        });
        stream.end('ok');
        return;
      }

      if (path.startsWith('/echo')) {
        stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' });
        stream.end(body);
        return;
      }

      if (path.startsWith('/json')) {
        stream.respond({ ':status': 200, 'content-type': 'application/json', 'x-test': 'yes' });
        stream.end('{"ok":true}');
        return;
      }

      if (path.startsWith('/overlap')) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        stream.respond({ ':status': 200, 'content-type': 'text/plain' });
        stream.end('ok');
        return;
      }

      stream.respond({ ':status': 200, 'content-type': 'text/plain' });
      stream.end('ok');
    })().catch(() => {
      if (!stream.closed) {
        try {
          stream.close();
        } catch {
          // already gone
        }
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  const origin = `https://localhost:${address.port}`;

  const close = async (): Promise<void> => {
    for (const session of liveSessions) {
      try {
        session.destroy();
      } catch {
        // already gone
      }
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 1000);
      server.close((error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  };

  const waitForSessionClose = async (previous: number, timeoutMs = 3000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (sessionCloses <= previous) {
      if (Date.now() > deadline) {
        throw new Error(`session close was not observed (closes=${sessionCloses})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  return {
    captured,
    close,
    get concurrentMax() {
      return concurrentMax;
    },
    origin,
    port: address.port,
    get sessionCloses() {
      return sessionCloses;
    },
    get sessions() {
      return sessions;
    },
    url: (path: string) => `${origin}${path}`,
    waitForSessionClose,
  };
};
