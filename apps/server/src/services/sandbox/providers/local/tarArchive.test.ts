import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createTarFileExtractStream,
  extractTar,
  extractTarFile,
  packTarFile,
  packTarFiles,
} from './tarArchive';

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

  it('packs multiple files with parent directory entries', () => {
    const tar = packTarFiles([
      { content: Buffer.from('a'), name: 'uploads/a.txt' },
      { content: Buffer.alloc(0), name: '.lobe-files-initialized' },
    ]);
    const entries = extractTar(tar);
    expect(entries.map((entry) => `${entry.type}:${entry.name}`)).toEqual(
      expect.arrayContaining([
        'directory:uploads',
        'file:uploads/a.txt',
        'file:.lobe-files-initialized',
      ]),
    );
    expect(extractTarFile(tar, 'uploads/a.txt').toString('utf8')).toBe('a');
  });

  it('round-trips a 40-character CJK name via a PAX path header', () => {
    const name = `${'测'.repeat(40)}.txt`;
    expect(Buffer.byteLength(name, 'utf8')).toBeGreaterThan(100);

    const tar = packTarFile(name, 'hello-cjk');
    const files = extractTar(tar).filter((entry) => entry.type === 'file');

    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe(name);
    expect(files[0]?.content.toString('utf8')).toBe('hello-cjk');
    expect(extractTarFile(tar, name).toString('utf8')).toBe('hello-cjk');
  });

  it('keeps a collision-preventing suffix on a CJK upload basename', () => {
    const name = `uploads/${'测'.repeat(40)}-file-1.pdf`;
    const tar = packTarFiles([{ content: Buffer.from('pdf'), name }]);
    const files = extractTar(tar).filter((entry) => entry.type === 'file');

    expect(files.map((entry) => entry.name)).toEqual([name]);
    expect(files[0]?.content.toString('utf8')).toBe('pdf');
  });
});
