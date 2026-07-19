// @vitest-environment node
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { BrandingAssetValidationError, validateBrandingAsset } from './assetStorage';

const png = async (width = 16, height = 16) =>
  sharp({ create: { background: '#3366ff', channels: 4, height, width } })
    .png()
    .toBuffer();

describe('validateBrandingAsset', () => {
  it('accepts a fully decoded canonical PNG', async () => {
    const bytes = await png();
    await expect(
      validateBrandingAsset({ bytesBase64: bytes.toString('base64'), fileName: 'logo.png' }),
    ).resolves.toMatchObject({ height: 16, mimeType: 'image/png', width: 16 });
  });

  it.each([
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'logo.svg'],
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
