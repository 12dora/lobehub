import { describe, expect, it } from 'vitest';

import { readImageDimensions, readImageMimeType } from './imageDimensions';

const bytes = (...values: (number | string)[]): Uint8Array => {
  const out: number[] = [];
  for (const value of values) {
    if (typeof value === 'number') out.push(value);
    else for (const char of value) out.push(char.charCodeAt(0));
  }
  return new Uint8Array(out);
};

const u32be = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const u16be = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
const u16le = (value: number) => [value & 0xff, (value >>> 8) & 0xff];
const u24le = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];

const png = (width: number, height: number) =>
  bytes(
    0x89,
    'PNG',
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    'IHDR',
    ...u32be(width),
    ...u32be(height),
    8,
    6,
    0,
    0,
    0,
  );

/** SOI, an APP0 segment to skip over, then the SOF0 frame header. */
const jpeg = (width: number, height: number, marker = 0xc0) =>
  bytes(
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...u16be(16),
    'JFIF',
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    marker,
    ...u16be(17),
    8,
    ...u16be(height),
    ...u16be(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  );

const gif = (width: number, height: number) =>
  bytes('GIF89a', ...u16le(width), ...u16le(height), 0xf7, 0, 0);

const webpVp8 = (width: number, height: number) =>
  bytes(
    'RIFF',
    ...u32be(0),
    'WEBP',
    'VP8 ',
    ...u32be(0),
    0x30,
    0x01,
    0x00,
    0x9d,
    0x01,
    0x2a,
    ...u16le(width),
    ...u16le(height),
  );

const webpVp8l = (width: number, height: number) => {
  const packed = (width - 1) | ((height - 1) << 14);
  return bytes(
    'RIFF',
    ...u32be(0),
    'WEBP',
    'VP8L',
    ...u32be(0),
    0x2f,
    packed & 0xff,
    (packed >>> 8) & 0xff,
    (packed >>> 16) & 0xff,
    (packed >>> 24) & 0xff,
  );
};

const webpVp8x = (width: number, height: number) =>
  bytes(
    'RIFF',
    ...u32be(0),
    'WEBP',
    'VP8X',
    ...u32be(10),
    0x10,
    0,
    0,
    0,
    ...u24le(width - 1),
    ...u24le(height - 1),
  );

describe('readImageDimensions', () => {
  it.each([
    ['png', png(1024, 768), { height: 768, mimeType: 'image/png', width: 1024 }],
    ['jpeg (SOF0)', jpeg(640, 480), { height: 480, mimeType: 'image/jpeg', width: 640 }],
    [
      'jpeg (progressive SOF2)',
      jpeg(300, 200, 0xc2),
      { height: 200, mimeType: 'image/jpeg', width: 300 },
    ],
    ['gif', gif(120, 90), { height: 90, mimeType: 'image/gif', width: 120 }],
    ['webp lossy', webpVp8(800, 600), { height: 600, mimeType: 'image/webp', width: 800 }],
    ['webp lossless', webpVp8l(64, 32), { height: 32, mimeType: 'image/webp', width: 64 }],
    ['webp extended', webpVp8x(4096, 2160), { height: 2160, mimeType: 'image/webp', width: 4096 }],
  ])('reads %s headers', (_name, input, expected) => {
    expect(readImageDimensions(input)).toEqual(expected);
  });

  it('ignores the 14-bit scaling bits of a lossy webp header', () => {
    // the two high bits of each 16-bit field are the horizontal/vertical scale
    const input = webpVp8(1024, 768);
    input[27] |= 0xc0;
    input[29] |= 0xc0;
    expect(readImageDimensions(input)).toEqual({
      height: 768,
      mimeType: 'image/webp',
      width: 1024,
    });
  });

  it('skips a standalone TEM marker instead of reading it as a segment', () => {
    // FF01 carries no length; treating it as one walks the parser off the frame
    const input = jpeg(640, 480);
    const withTem = bytes(0xff, 0xd8, 0xff, 0x01, ...[...input].slice(2));
    expect(readImageDimensions(withTem)).toEqual({
      height: 480,
      mimeType: 'image/jpeg',
      width: 640,
    });
  });

  it.each([
    ['an empty buffer', new Uint8Array()],
    ['a truncated png', png(10, 10).subarray(0, 18)],
    ['a bmp', bytes('BM', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)],
    ['a riff container that is not webp', bytes('RIFF', 0, 0, 0, 0, 'AVI ', 0, 0, 0, 0, 0, 0)],
    ['a jpeg without a frame header', bytes(0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0, 0, 0, 0, 0)],
    [
      'a jpeg segment shorter than its own header',
      bytes(0xff, 0xd8, 0xff, 0xc0, 0, 4, 8, 0, 1, 0, 1, 3),
    ],
    ['a gif with an unknown version', bytes('GIF88x', ...u16le(4), ...u16le(4), 0, 0, 0)],
    ['a three-letter GIF prefix only', bytes('GIFxxx', ...u16le(4), ...u16le(4), 0, 0, 0)],
    [
      'a webp whose VP8 start code is wrong',
      (() => {
        const input = webpVp8(64, 32);
        input[23] = 0x00;
        return input;
      })(),
    ],
    [
      'a webp whose VP8L signature is wrong',
      (() => {
        const input = webpVp8l(64, 32);
        input[20] = 0x00;
        return input;
      })(),
    ],
  ])('returns undefined for %s', (_name, input) => {
    expect(readImageDimensions(input)).toBeUndefined();
  });

  it('never throws on a truncated header, at any offset', () => {
    const fixtures = [
      png(1024, 768),
      jpeg(640, 480),
      gif(120, 90),
      webpVp8(800, 600),
      webpVp8l(64, 32),
      webpVp8x(4096, 2160),
      // a hostile jpeg: fill bytes, a zero-length segment and a runaway length
      bytes(0xff, 0xd8, 0xff, 0xff, 0xff, 0xe0, 0, 0, 0xff, 0xc0, 0xff, 0xff, 8, 1, 1, 1, 1),
    ];

    for (const fixture of fixtures) {
      for (let end = 0; end <= fixture.length; end += 1) {
        expect(() => readImageDimensions(fixture.subarray(0, end))).not.toThrow();
      }
    }
  });

  it('exposes the mime type alone', () => {
    expect(readImageMimeType(png(2, 2))).toBe('image/png');
    expect(readImageMimeType(new Uint8Array(4))).toBeUndefined();
  });
});
