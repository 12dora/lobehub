import urlJoin from 'url-join';

export interface S3PublicUrlConfig {
  bucket?: string;
  forcePathStyle: boolean;
  publicDomain?: string;
  setAcl: boolean;
}

/**
 * Public object URL when ACL + public domain are both set; otherwise `null`
 * so the caller can fall back to a presigned preview URL.
 *
 * Characterization of `S3StaticFileImpl.getFullFileUrl` (pre-infra-settings).
 */
export const buildPublicFileUrl = (key: string, config: S3PublicUrlConfig): string | null => {
  const publicUrlBase = config.setAcl ? config.publicDomain : undefined;
  if (!publicUrlBase) return null;

  if (config.forcePathStyle) {
    return urlJoin(publicUrlBase, config.bucket!, key);
  }

  return urlJoin(publicUrlBase, key);
};

/**
 * Extract an object key from an S3-style pathname (legacy URL compatibility).
 * `/f/{fileId}` proxy URLs are handled by the caller via the file table.
 */
export const extractKeyFromS3Pathname = (
  pathname: string,
  config: Pick<S3PublicUrlConfig, 'bucket' | 'forcePathStyle'>,
): string => {
  if (config.forcePathStyle) {
    if (!config.bucket) {
      return pathname.startsWith('/') ? pathname.slice(1) : pathname;
    }
    const bucketPrefix = `/${config.bucket}/`;
    if (pathname.startsWith(bucketPrefix)) {
      return pathname.slice(bucketPrefix.length);
    }
    return pathname.startsWith('/') ? pathname.slice(1) : pathname;
  }

  return pathname.slice(1);
};
