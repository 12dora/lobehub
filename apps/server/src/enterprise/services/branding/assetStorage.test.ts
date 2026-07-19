// @vitest-environment node
import { gzipSync } from 'node:zlib';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { BrandingAssetValidationError, validateBrandingAsset } from './assetStorage';

const png = async (width = 16, height = 16) =>
  sharp({ create: { background: '#3366ff', channels: 4, height, width } })
    .png()
    .toBuffer();

const animatedWebp = Buffer.from(
  'UklGRgwBAABXRUJQVlA4WAoAAAACAAAAAwAAAgAAQU5JTQYAAAD/////AABBTk1GdAAAAAAAAAAAAAMAAAIAAPQBAAJWUDggXAAAANABAJ0BKgQAAwABQCYlsAJ0AQ7+A44AAP79rX1UTf/b71P1jtLtlaMv/zRfa23+/+P+v/5vE9tBH/8tv/df+MC3/Jv//zoPll+//yb/4vmQBpfifMr6SjfC8AAAQU5NRmQAAAAAAAAAAAADAAACAAD0AQAAVlA4IEwAAAD0AQCdASoEAAMAAAAmJaACdDBMAZB45UAA/v2zvVe1/ZvvJLNHeuSmpHc66bn/M/9v/x/BX9HsZO/nft6fid+ha6n89jCWy3Kh78AA',
  'base64',
);

const animatedPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAABAAAAAQBPJcTWAAAACGFjVEz/////AAAAAWSX0BAAAAAaZmNUTAAAAAAAAAAEAAAABAAAAAAAAAAAAAEAAgAAWWFSWQAAACdJREFUeJw9iUEKADAIwxLw4f68U4TlUFIiEDC7xVoi3vnU1MaJLQ8FTAoMnzDusgAAABpmY1RMAAAAAQAAAAQAAAABAAAAAAAAAAMAAQACAADAfRybAAAAGWZkQVQAAAACeJxj/N/AwFjPwNDw/38jAwAgCgUAErba+AAAAABJRU5ErkJggg==',
  'base64',
);

const icoDirectory = (overlap: boolean): Buffer => {
  const bytes = Buffer.alloc(40);
  bytes.writeUInt16LE(0, 0);
  bytes.writeUInt16LE(1, 2);
  bytes.writeUInt16LE(2, 4);
  bytes.writeUInt32LE(1, 14);
  bytes.writeUInt32LE(38, 18);
  bytes.writeUInt32LE(1, 30);
  bytes.writeUInt32LE(overlap ? 38 : 39, 34);
  return bytes;
};

describe('validateBrandingAsset', () => {
  it('accepts a fully decoded canonical PNG', async () => {
    const bytes = await png();
    await expect(
      validateBrandingAsset({ bytesBase64: bytes.toString('base64'), fileName: 'logo.png' }),
    ).resolves.toMatchObject({ height: 16, mimeType: 'image/png', width: 16 });
  });

  it('accepts PNG for the public favicon slot', async () => {
    const bytes = await png(32, 32);
    await expect(
      validateBrandingAsset({ bytesBase64: bytes.toString('base64'), fileName: 'favicon.png' }),
    ).resolves.toMatchObject({ mimeType: 'image/png' });
  });

  it.each([
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'logo.svg'],
    ['SVGZ', gzipSync(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'logo.svgz'],
    ['well-bounded multi-entry ICO', icoDirectory(false), 'favicon.ico'],
    ['overlapping multi-entry ICO', icoDirectory(true), 'favicon.ico'],
    ['extension mismatch', Buffer.from('not an image'), 'logo.png'],
  ])('rejects %s before storage', async (_label, bytes, fileName) => {
    await expect(
      validateBrandingAsset({ bytesBase64: bytes.toString('base64'), fileName }),
    ).rejects.toBeInstanceOf(BrandingAssetValidationError);
  });

  it('rejects valid image bytes with an appended polyglot payload', async () => {
    const bytes = Buffer.concat([await png(), Buffer.from('<script>alert(1)</script>')]);
    await expect(
      validateBrandingAsset({ bytesBase64: bytes.toString('base64'), fileName: 'logo.png' }),
    ).rejects.toBeInstanceOf(BrandingAssetValidationError);
  });

  it.each([
    ['animated WebP', animatedWebp, 'logo.webp'],
    ['animated PNG', animatedPng, 'logo.png'],
  ])('rejects %s', async (_label, bytes, fileName) => {
    await expect(
      validateBrandingAsset({ bytesBase64: bytes.toString('base64'), fileName }),
    ).rejects.toBeInstanceOf(BrandingAssetValidationError);
  });

  it('rejects oversized dimensions before storage', async () => {
    const bytes = await png(4097, 1);
    await expect(
      validateBrandingAsset({ bytesBase64: bytes.toString('base64'), fileName: 'wide.png' }),
    ).rejects.toBeInstanceOf(BrandingAssetValidationError);
  });

  it('rejects non-canonical base64 instead of relying on Buffer leniency', async () => {
    const bytes = await png();
    await expect(
      validateBrandingAsset({ bytesBase64: `${bytes.toString('base64')}!`, fileName: 'logo.png' }),
    ).rejects.toBeInstanceOf(BrandingAssetValidationError);
  });
});
