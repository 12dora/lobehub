import { describe, expect, it } from 'vitest';

import { fileUrlPartPlaceholder, isFileUrlPart, isFileUrlTypedPart } from './chat';

describe('isFileUrlPart', () => {
  const validPart = {
    file_url: {
      content: 'PARSED TEXT',
      fileId: 'file_1',
      mimeType: 'application/pdf',
      name: 'report.pdf',
      size: 2048,
      url: 'https://example.com/report.pdf',
    },
    type: 'file_url',
  };

  it('accepts a fully populated part', () => {
    expect(isFileUrlPart(validPart)).toBe(true);
  });

  it('accepts a part with only the required fields', () => {
    expect(
      isFileUrlPart({
        file_url: { name: 'report.pdf', url: 'https://example.com/report.pdf' },
        type: 'file_url',
      }),
    ).toBe(true);
  });

  const malformed: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'file_url'],
    ['a number', 42],
    ['an array', [validPart]],
    ['a text part', { text: 'hello', type: 'text' }],
    ['an image part', { image_url: { url: 'https://example.com/a.png' }, type: 'image_url' }],
    ['a wrong type discriminator', { ...validPart, type: 'file' }],
    ['a missing file_url', { type: 'file_url' }],
    ['a null file_url', { file_url: null, type: 'file_url' }],
    ['a string file_url', { file_url: 'https://example.com/report.pdf', type: 'file_url' }],
    ['an array file_url', { file_url: [], type: 'file_url' }],
    ['a missing url', { file_url: { name: 'report.pdf' }, type: 'file_url' }],
    ['a non-string url', { file_url: { name: 'report.pdf', url: 42 }, type: 'file_url' }],
    ['an empty url', { file_url: { name: 'report.pdf', url: '   ' }, type: 'file_url' }],
    ['a missing name', { file_url: { url: 'https://example.com/report.pdf' }, type: 'file_url' }],
    [
      'a non-string name',
      { file_url: { name: { a: 1 }, url: 'https://example.com/report.pdf' }, type: 'file_url' },
    ],
    [
      'an empty name',
      { file_url: { name: '', url: 'https://example.com/report.pdf' }, type: 'file_url' },
    ],
    [
      'a non-string mimeType',
      { file_url: { ...validPart.file_url, mimeType: 1 }, type: 'file_url' },
    ],
    ['a non-string fileId', { file_url: { ...validPart.file_url, fileId: {} }, type: 'file_url' }],
    [
      'an object content',
      { file_url: { ...validPart.file_url, content: { text: 'x' } }, type: 'file_url' },
    ],
    ['a non-number size', { file_url: { ...validPart.file_url, size: '2048' }, type: 'file_url' }],
    ['a NaN size', { file_url: { ...validPart.file_url, size: Number.NaN }, type: 'file_url' }],
    [
      'an Infinity size',
      { file_url: { ...validPart.file_url, size: Number.POSITIVE_INFINITY }, type: 'file_url' },
    ],
  ];

  it.each(malformed)('rejects %s', (_label, part) => {
    expect(isFileUrlPart(part)).toBe(false);
  });
});

describe('isFileUrlTypedPart', () => {
  it('matches every object claiming the file_url type, even a malformed one', () => {
    expect(isFileUrlTypedPart({ type: 'file_url' })).toBe(true);
    expect(isFileUrlTypedPart({ file_url: { name: 'a.pdf' }, type: 'file_url' })).toBe(true);
  });

  it('does not match other parts', () => {
    expect(isFileUrlTypedPart({ text: 'hi', type: 'text' })).toBe(false);
    expect(isFileUrlTypedPart(null)).toBe(false);
    expect(isFileUrlTypedPart('file_url')).toBe(false);
  });
});

describe('fileUrlPartPlaceholder', () => {
  it('uses the file name when it is a usable string', () => {
    expect(
      fileUrlPartPlaceholder({
        file_url: { name: 'report.pdf', url: 'https://example.com/report.pdf' },
        type: 'file_url',
      }),
    ).toBe('[file omitted: report.pdf]');
  });

  it.each([
    ['a missing name', { file_url: { url: 'https://example.com/a.pdf' }, type: 'file_url' }],
    ['an object name', { file_url: { name: { a: 1 }, url: 'x' }, type: 'file_url' }],
    ['a blank name', { file_url: { name: '  ', url: 'x' }, type: 'file_url' }],
    ['a missing file_url', { type: 'file_url' }],
  ])('degrades to a generic marker for %s', (_label, part) => {
    const placeholder = fileUrlPartPlaceholder(part);

    expect(placeholder).toBe('[file omitted]');
    expect(placeholder).not.toContain('undefined');
    expect(placeholder).not.toContain('[object Object]');
  });
});
