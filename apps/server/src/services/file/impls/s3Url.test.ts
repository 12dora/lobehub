import { describe, expect, it } from 'vitest';

import { buildPublicFileUrl, extractKeyFromS3Pathname } from './s3Url';

describe('buildPublicFileUrl (characterization of S3StaticFileImpl.getFullFileUrl)', () => {
  it('returns null when setAcl is false so the caller can presign', () => {
    expect(
      buildPublicFileUrl('path/to/file.jpg', {
        bucket: 'my-bucket',
        forcePathStyle: false,
        publicDomain: 'https://example.com',
        setAcl: false,
      }),
    ).toBeNull();
  });

  it('returns null when public domain is missing', () => {
    expect(
      buildPublicFileUrl('path/to/file.jpg', {
        bucket: 'my-bucket',
        forcePathStyle: false,
        setAcl: true,
      }),
    ).toBeNull();
  });

  it('joins public domain + key for virtual-hosted style', () => {
    expect(
      buildPublicFileUrl('path/to/file.jpg', {
        bucket: 'my-bucket',
        forcePathStyle: false,
        publicDomain: 'https://example.com',
        setAcl: true,
      }),
    ).toBe('https://example.com/path/to/file.jpg');
  });

  it('joins public domain + bucket + key for path style', () => {
    expect(
      buildPublicFileUrl('path/to/file.jpg', {
        bucket: 'my-bucket',
        forcePathStyle: true,
        publicDomain: 'https://example.com',
        setAcl: true,
      }),
    ).toBe('https://example.com/my-bucket/path/to/file.jpg');
  });
});

describe('extractKeyFromS3Pathname (characterization of getKeyFromFullUrl)', () => {
  it('strips the leading slash for virtual-hosted style', () => {
    expect(extractKeyFromS3Pathname('/path/to/file.jpg', { forcePathStyle: false })).toBe(
      'path/to/file.jpg',
    );
  });

  it('strips /{bucket}/ for path style', () => {
    expect(
      extractKeyFromS3Pathname('/my-bucket/path/to/file.jpg', {
        bucket: 'my-bucket',
        forcePathStyle: true,
      }),
    ).toBe('path/to/file.jpg');
  });

  it('falls back to the pathname when the bucket prefix is absent', () => {
    expect(
      extractKeyFromS3Pathname('/other/path/to/file.jpg', {
        bucket: 'my-bucket',
        forcePathStyle: true,
      }),
    ).toBe('other/path/to/file.jpg');
  });

  it('strips a leading slash when path style has no bucket', () => {
    expect(extractKeyFromS3Pathname('/path/to/file.jpg', { forcePathStyle: true })).toBe(
      'path/to/file.jpg',
    );
  });
});
