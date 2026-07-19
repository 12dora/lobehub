import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';

import type { LobeChatDatabase } from '@/database/type';
import { fileEnv } from '@/envs/file';
import { FileService } from '@/server/services/file';

import type { AdminBrandingUploadAssetInput } from '../../contracts/adminBranding';

const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const MAX_PIXELS = 16_777_216;

const supportedAssets = {
  ico: { extensions: ['.ico'], mimeType: 'image/x-icon' },
  jpg: { extensions: ['.jpeg', '.jpg'], mimeType: 'image/jpeg' },
  png: { extensions: ['.png'], mimeType: 'image/png' },
  webp: { extensions: ['.webp'], mimeType: 'image/webp' },
} as const;

type SupportedAssetExtension = keyof typeof supportedAssets;
export type BrandingAssetMimeType = (typeof supportedAssets)[SupportedAssetExtension]['mimeType'];

export class BrandingAssetValidationError extends Error {
  constructor() {
    super('BRANDING_ASSET_INVALID');
    this.name = 'BrandingAssetValidationError';
  }
}

export class BrandingAssetStorageUnavailableError extends Error {
  constructor() {
    super('BRANDING_ASSET_STORAGE_UNAVAILABLE');
    this.name = 'BrandingAssetStorageUnavailableError';
  }
}

export interface ValidatedBrandingAsset {
  bytes: Buffer;
  extension: SupportedAssetExtension;
  height: number;
  mimeType: BrandingAssetMimeType;
  width: number;
}

export interface BrandingAssetStorage {
  isConfigured: () => boolean;
  upload: (params: {
    actorUserId: string;
    asset: ValidatedBrandingAsset;
    fileName: string;
    kind: AdminBrandingUploadAssetInput['kind'];
  }) => Promise<{ url: string }>;
}

const isCanonicalBase64 = (value: string, bytes: Buffer): boolean => {
  if (!/^(?:[A-Z\d+/]{4})*(?:[A-Z\d+/]{2}==|[A-Z\d+/]{3}=)?$/i.test(value)) {
    return false;
  }
  return bytes.toString('base64') === value;
};

const hasExactContainerLength = (bytes: Buffer, extension: SupportedAssetExtension): boolean => {
  if (extension === 'png') {
    const trailer = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    return bytes.length >= trailer.length && bytes.subarray(-trailer.length).equals(trailer);
  }
  if (extension === 'jpg')
    return bytes.length >= 2 && bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]));
  if (extension === 'webp') {
    return bytes.length >= 12 && bytes.readUInt32LE(4) + 8 === bytes.length;
  }

  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return false;
  const count = bytes.readUInt16LE(4);
  if (count < 1 || count > 64 || bytes.length < 6 + count * 16) return false;
  let exactEnd = 0;
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 16;
    const size = bytes.readUInt32LE(offset + 8);
    const imageOffset = bytes.readUInt32LE(offset + 12);
    if (size === 0 || imageOffset < 6 + count * 16 || imageOffset + size > bytes.length)
      return false;
    exactEnd = Math.max(exactEnd, imageOffset + size);
  }
  return exactEnd === bytes.length;
};

export const validateBrandingAsset = async (params: {
  bytesBase64: string;
  fileName: string;
}): Promise<ValidatedBrandingAsset> => {
  const bytes = Buffer.from(params.bytesBase64, 'base64');
  if (
    bytes.length === 0 ||
    bytes.length > MAX_ASSET_BYTES ||
    !isCanonicalBase64(params.bytesBase64, bytes)
  ) {
    throw new BrandingAssetValidationError();
  }

  const detected = await fileTypeFromBuffer(bytes);
  const definition = detected && supportedAssets[detected.ext as SupportedAssetExtension];
  const extension = path.extname(params.fileName).toLowerCase();
  if (
    !detected ||
    !definition ||
    detected.mime !== definition.mimeType ||
    !(definition.extensions as readonly string[]).includes(extension) ||
    !hasExactContainerLength(bytes, detected.ext as SupportedAssetExtension)
  ) {
    throw new BrandingAssetValidationError();
  }

  try {
    const image = sharp(bytes, {
      animated: false,
      failOn: 'error',
      limitInputPixels: MAX_PIXELS,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    const width = metadata.width;
    const height = metadata.height;
    if (
      !width ||
      !height ||
      width > MAX_DIMENSION ||
      height > MAX_DIMENSION ||
      width * height > MAX_PIXELS
    ) {
      throw new BrandingAssetValidationError();
    }

    // Force a complete decode after metadata parsing to reject truncated and decompression-bomb data.
    await image.clone().raw().toBuffer({ resolveWithObject: true });
    return {
      bytes,
      extension: detected.ext as SupportedAssetExtension,
      height,
      mimeType: definition.mimeType,
      width,
    };
  } catch (error) {
    if (error instanceof BrandingAssetValidationError) throw error;
    throw new BrandingAssetValidationError();
  }
};

export class FileBrandingAssetStorage implements BrandingAssetStorage {
  constructor(private readonly db: LobeChatDatabase) {}

  isConfigured = (): boolean =>
    Boolean(fileEnv.S3_BUCKET && (fileEnv.S3_ENDPOINT || fileEnv.S3_REGION));

  upload = async (params: {
    actorUserId: string;
    asset: ValidatedBrandingAsset;
    fileName: string;
    kind: AdminBrandingUploadAssetInput['kind'];
  }): Promise<{ url: string }> => {
    if (!this.isConfigured()) throw new BrandingAssetStorageUnavailableError();

    const key = `branding/${params.kind}/${randomUUID()}.${params.asset.extension}`;
    const service = new FileService(this.db, params.actorUserId);
    await service.uploadBuffer(key, params.asset.bytes, params.asset.mimeType);
    const record = await service.createFileRecord({
      fileHash: createHash('sha256').update(params.asset.bytes).digest('hex'),
      fileType: params.asset.mimeType,
      metadata: {
        brandingAsset: true,
        height: params.asset.height,
        kind: params.kind,
        width: params.asset.width,
      },
      name: params.fileName,
      size: params.asset.bytes.length,
      url: key,
    });

    return { url: `/f/${record.fileId}` };
  };
}
