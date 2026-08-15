import { describe, expect, it } from 'vitest';

import {
  extractSandboxFiles,
  mimeTypeForFileName,
  resolveFileMimeType,
  sandboxFileName,
} from './interpreterFiles';

describe('extractSandboxFiles', () => {
  it('reads the markdown link shape the model actually emits', () => {
    expect(
      extractSandboxFiles('Done: [Download aihub-test.pdf](sandbox:/mnt/data/aihub-test.pdf)'),
    ).toEqual([
      {
        name: 'aihub-test.pdf',
        path: '/mnt/data/aihub-test.pdf',
        sandboxPath: 'sandbox:/mnt/data/aihub-test.pdf',
      },
    ]);
  });

  it('reads a bare mention and drops the sentence punctuation', () => {
    expect(
      extractSandboxFiles('saved to sandbox:/mnt/data/report.docx.').map((f) => f.path),
    ).toEqual(['/mnt/data/report.docx']);
  });

  it('drops the CJK sentence punctuation of a Chinese answer', () => {
    expect(
      extractSandboxFiles(
        '报告已保存到 sandbox:/mnt/data/报告.pdf。另见 sandbox:/mnt/data/b.csv、',
      ).map((file) => file.path),
    ).toEqual(['/mnt/data/报告.pdf', '/mnt/data/b.csv']);
    expect(extractSandboxFiles('见 sandbox:/mnt/data/a.pdf」')[0].name).toBe('a.pdf');
  });

  it('orders mixed bare and markdown references by where they appear', () => {
    const text = 'bare sandbox:/mnt/data/b.csv then [a](sandbox:/mnt/data/a.pdf)';
    expect(extractSandboxFiles(text).map((file) => file.path)).toEqual([
      '/mnt/data/b.csv',
      '/mnt/data/a.pdf',
    ]);
  });

  it('deduplicates a path referenced twice, keeping the order of appearance', () => {
    const text =
      '[a](sandbox:/mnt/data/a.pdf) and [again](sandbox:/mnt/data/a.pdf) plus sandbox:/mnt/data/b.csv';
    expect(extractSandboxFiles(text).map((file) => file.path)).toEqual([
      '/mnt/data/a.pdf',
      '/mnt/data/b.csv',
    ]);
  });

  it('never reads the tail of an unterminated markdown link as a bare mention', () => {
    // exactly what the wire carries when a leg is cut mid-link — resolving
    // `/mnt/data/ai` would 404 on a name that never existed
    expect(extractSandboxFiles('Done: [Download aihub-test.pdf](sandbox:/mnt/data/ai')).toEqual([]);
    // …while a genuine bare mention is read even without a closing paren
    expect(
      extractSandboxFiles('saved to sandbox:/mnt/data/out.csv').map((file) => file.path),
    ).toEqual(['/mnt/data/out.csv']);
  });

  it('ignores an unterminated link while the answer is still streaming', () => {
    // exactly what the wire carries mid-stream: `…](sandbox:/mnt/data/ai`
    const partial = 'Done: [Download aihub-test.pdf](sandbox:/mnt/data/ai';
    expect(extractSandboxFiles(partial, { requireClosed: true })).toEqual([]);
    // …and the same text, once finished, resolves the real path
    expect(
      extractSandboxFiles(`${partial}hub-test.pdf)`, { requireClosed: true }).map((f) => f.path),
    ).toEqual(['/mnt/data/aihub-test.pdf']);
  });

  it('ignores text without any sandbox reference', () => {
    expect(extractSandboxFiles('no files here')).toEqual([]);
    expect(extractSandboxFiles('')).toEqual([]);
    expect(extractSandboxFiles('sandbox:/mnt/data/')).toEqual([]);
  });

  it('decodes a percent-escaped path', () => {
    expect(extractSandboxFiles('[x](sandbox:/mnt/data/my%20report.pdf)')[0]).toMatchObject({
      name: 'my report.pdf',
      path: '/mnt/data/my report.pdf',
    });
  });
});

describe('sandboxFileName', () => {
  it('takes the basename and strips traversal / header-breaking characters', () => {
    expect(sandboxFileName('sandbox:/mnt/data/sub/report.pdf')).toBe('report.pdf');
    expect(sandboxFileName('/mnt/data/../../etc/passwd')).toBe('passwd');
    expect(sandboxFileName('/mnt/data/we"ird:name?.txt')).toBe('weirdname.txt');
    expect(sandboxFileName('/mnt/data/')).toBe('download');
  });

  it('caps the name at 128 chars while keeping the extension', () => {
    const name = sandboxFileName(`/mnt/data/${'a'.repeat(400)}.pdf`);
    expect(name.length).toBe(128);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('resolveFileMimeType', () => {
  it('prefers the response content-type, without its parameters', () => {
    expect(resolveFileMimeType('application/pdf; charset=binary', 'a.pdf')).toBe('application/pdf');
  });

  it('falls back to the extension when the header is missing or generic', () => {
    expect(resolveFileMimeType(undefined, 'a.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(resolveFileMimeType('binary/octet-stream', 'a.csv')).toBe('text/csv');
    expect(resolveFileMimeType('application/octet-stream', 'a.unknown-ext')).toBe(
      'application/octet-stream',
    );
  });

  it('maps the extensions the interpreter commonly produces', () => {
    expect(mimeTypeForFileName('a.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(mimeTypeForFileName('a.zip')).toBe('application/zip');
    expect(mimeTypeForFileName('noextension')).toBeUndefined();
  });
});
