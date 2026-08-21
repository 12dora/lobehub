import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createTarFileExtractStream, extractTarFile, packTarFile } from './tarArchive';

describe('tarArchive', () => {
  it('round-trips a packed file', () => {
    const tar = packTarFile('hello.txt', 'hello sandbox');
    expect(extractTarFile(tar, 'hello.txt').toString('utf8')).toBe('hello sandbox');
  });

  it('streams a single file out of a tar without buffering the archive', async () => {
    const payload = Buffer.from('streamed-export');
    const tar = packTarFile('out.txt', payload);
    const extract = createTarFileExtractStream({
      basename: 'out.txt',
      expectedSize: payload.length,
    });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      extract.on('data', (chunk: Buffer) => chunks.push(chunk));
      extract.on('end', () => resolve());
      extract.on('error', reject);
      Readable.from(tar).pipe(extract);
    });
    expect(Buffer.concat(chunks).toString('utf8')).toBe('streamed-export');
  });
});
