/** Streaming NDJSON artifact writer with incremental SHA-256 and backpressure. */

import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';

import { AuditExportArtifactTooLargeError } from './exportWorkerErrors';
import { writeWithBackpressure } from './exportWorkerShared';

export type ArtifactWriter = {
  digestHex: () => string;
  dispose: () => Promise<void>;
  end: () => Promise<void>;
  readonly lineCount: number;
  readonly totalBytes: number;
  writeLine: (line: string) => Promise<void>;
};

export const createArtifactWriter = (params: {
  createArtifactWriteStream?: (tmpPath: string) => NodeJS.WritableStream;
  maxArtifactBytes: number;
  tmpPath: string;
}): ArtifactWriter => {
  let lineCount = 0;
  let totalBytes = 0;
  const hasher = createHash('sha256');
  const fileStream = (
    params.createArtifactWriteStream
      ? params.createArtifactWriteStream(params.tmpPath)
      : createWriteStream(params.tmpPath, { flags: 'w' })
  ) as WriteStream;
  // SAO-006: record stream errors immediately — never rethrow into an unhandled
  // rejection while the worker awaits materialization / other macrotasks.
  // Premature close from intentional destroy() in finally is expected.
  let fileClosedIntentionally = false;
  let streamError: Error | null = null;
  const fileFinished = finished(fileStream).catch((err: NodeJS.ErrnoException) => {
    if (fileClosedIntentionally && err?.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    streamError = err instanceof Error ? err : new Error(String(err));
  });

  const writeLine = async (line: string) => {
    if (streamError) throw streamError;
    const buf = Buffer.from(line, 'utf8');
    hasher.update(buf);
    totalBytes += buf.byteLength;
    if (totalBytes > params.maxArtifactBytes) {
      throw new AuditExportArtifactTooLargeError();
    }
    lineCount += 1;
    const pending = writeWithBackpressure(fileStream, buf);
    if (pending) await pending;
    if (streamError) throw streamError;
  };

  return {
    digestHex: () => hasher.digest('hex'),
    dispose: async () => {
      fileClosedIntentionally = true;
      if (!fileStream.destroyed) {
        fileStream.destroy();
      }
      await fileFinished.catch(() => undefined);
      await rm(path.dirname(params.tmpPath), { recursive: true, force: true }).catch(
        () => undefined,
      );
    },
    end: async () => {
      if (streamError) throw streamError;
      fileStream.end();
      await fileFinished;
      if (streamError) throw streamError;
    },
    get lineCount() {
      return lineCount;
    },
    get totalBytes() {
      return totalBytes;
    },
    writeLine,
  };
};
