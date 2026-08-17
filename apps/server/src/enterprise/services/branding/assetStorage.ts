import path from 'node:path';

import { fileTypeFromBuffer } from 'file-type';

import type { LobeChatDatabase } from '@/database/type';
import { fileEnv } from '@/envs/file';
import { getInfraSnapshot } from '@/server/enterprise/services/infraSettings/snapshot';
import { createFileServiceModule } from '@/server/services/file/impls';

const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const MAX_PIXELS = 16_777_216;
const PNG_TRAILER_BYTES = 12;
const RIFF_CONTAINER_HEADER_BYTES = 8;

const supportedAssets = {
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
  delete: (objectKey: string) => Promise<void>;
  isConfigured: () => boolean | Promise<boolean>;
  upload: (params: { asset: ValidatedBrandingAsset; objectKey: string }) => Promise<void>;
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
    return (
      trailer.length === PNG_TRAILER_BYTES &&
      bytes.length >= trailer.length &&
      bytes.subarray(-trailer.length).equals(trailer)
    );
  }
  if (extension === 'jpg')
    return bytes.length >= 2 && bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]));
  if (extension === 'webp') {
    return (
      bytes.length >= PNG_TRAILER_BYTES &&
      bytes.readUInt32LE(4) + RIFF_CONTAINER_HEADER_BYTES === bytes.length
    );
  }
  return true;
};

const hasAnimationContainer = (bytes: Buffer, extension: SupportedAssetExtension): boolean => {
  if (extension === 'png') return bytes.includes(Buffer.from('acTL'));
  if (extension === 'webp') {
    return bytes.includes(Buffer.from('ANIM')) || bytes.includes(Buffer.from('ANMF'));
  }
  return false;
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
    !hasExactContainerLength(bytes, detected.ext as SupportedAssetExtension) ||
    hasAnimationContainer(bytes, detected.ext as SupportedAssetExtension)
  ) {
    throw new BrandingAssetValidationError();
  }

  try {
    const { default: sharp } = await import('sharp');
    const image = sharp(bytes, {
      animated: true,
      failOn: 'error',
      limitInputPixels: MAX_PIXELS,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    const width = metadata.width;
    const height = metadata.height;
    const pages = metadata.pages ?? 1;
    if (
      !width ||
      !height ||
      pages !== 1 ||
      (metadata.pageHeight !== undefined && metadata.pageHeight !== height) ||
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

  isConfigured = async (): Promise<boolean> => {
    try {
      const snapshot = await getInfraSnapshot();
      return snapshot.objectStorage.kind === 'complete';
    } catch {
      return Boolean(fileEnv.S3_BUCKET && (fileEnv.S3_ENDPOINT || fileEnv.S3_REGION));
    }
  };

  delete = async (objectKey: string): Promise<void> => {
    await createFileServiceModule(this.db).deleteFile(objectKey);
  };

  upload = async (params: { asset: ValidatedBrandingAsset; objectKey: string }): Promise<void> => {
    if (!(await this.isConfigured())) throw new BrandingAssetStorageUnavailableError();

    await createFileServiceModule(this.db).uploadBuffer(
      params.objectKey,
      params.asset.bytes,
      params.asset.mimeType,
      'public, max-age=31536000, immutable',
    );
  };
}
