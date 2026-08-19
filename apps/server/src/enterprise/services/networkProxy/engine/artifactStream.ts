import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import { NETWORK_PROXY_ENGINE_ERROR_CODES, throwNetworkProxyError } from './errors';
import { removeIfPresent } from './fsSecure';

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

const toNodeReadable = (stream: NodeJS.ReadableStream): Readable =>
  stream instanceof Readable ? stream : Readable.from(stream as AsyncIterable<Buffer>);

export const writeStreamToVerifiedFile = async (input: {
  /** Keep the file even when the digest differs from `expectedSha256` (operator-accepted upload). */
  acceptMismatch?: boolean;
  compressed: 'auto' | 'gzip' | 'none';
  expectedSha256: string;
  maxCompressed: number;
  maxDecompressed: number;
  mode: number;
  stream: NodeJS.ReadableStream;
  tmpPath: string;
}): Promise<{ digest: string; matched: boolean }> => {
  const handle = await open(
    input.tmpPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  const hash = createHash('sha256');
  let compressed = 0;
  let decompressed = 0;
  let encoding: 'gzip' | 'none' = input.compressed === 'gzip' ? 'gzip' : 'none';

  const fail = async (error: unknown): Promise<never> => {
    await handle.close().catch(() => undefined);
    await removeIfPresent(input.tmpPath);
    throw error;
  };

  try {
    const source = toNodeReadable(input.stream);
    const iterator = source[Symbol.asyncIterator]();
    const first = await iterator.next();
    const prefix = first.done
      ? Buffer.alloc(0)
      : Buffer.isBuffer(first.value)
        ? first.value
        : Buffer.from(first.value ?? '');
    if (input.compressed === 'auto' && prefix.length >= 2) {
      encoding = prefix[0] === GZIP_MAGIC_0 && prefix[1] === GZIP_MAGIC_1 ? 'gzip' : 'none';
    }
    const headed = Readable.from(
      (async function* prepend() {
        if (prefix.length) yield prefix;

        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          yield next.value;
        }
      })(),
    );

    const countCompressed = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        compressed += chunk.length;
        if (compressed > input.maxCompressed) {
          callback(new Error('compressed artifact exceeds the 64 MiB cap'));
          return;
        }
        callback(null, chunk);
      },
    });
    const countDecompressed = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        decompressed += chunk.length;
        if (decompressed > input.maxDecompressed) {
          callback(new Error('decompressed artifact exceeds the pinned size cap'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const dest = new Writable({
      write(chunk: Buffer, _enc, callback) {
        void handle.write(chunk).then(() => callback(), callback);
      },
    });

    if (encoding === 'gzip') {
      await pipeline(headed, countCompressed, createGunzip(), countDecompressed, dest);
    } else {
      await pipeline(headed, countCompressed, countDecompressed, dest);
    }

    const digest = hash.digest('hex');
    const matched = digest === input.expectedSha256;
    if (!matched && !input.acceptMismatch) {
      await handle.close().catch(() => undefined);
      await removeIfPresent(input.tmpPath);
      throwNetworkProxyError(NETWORK_PROXY_ENGINE_ERROR_CODES.ARTIFACT_MISMATCH);
    }
    await handle.sync();
    await handle.chmod(input.mode);
    await handle.close();
    return { digest, matched };
  } catch (error) {
    return fail(error);
  }
};
