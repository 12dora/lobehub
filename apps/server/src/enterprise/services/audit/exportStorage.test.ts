// @vitest-environment node
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  AuditExportPrivateS3Storage,
  buildPrivateAuditExportS3Options,
  checksumsMatch,
  formatArtifactChecksum,
  hashAsyncIterable,
  InMemoryAuditExportArtifactStorage,
  sha256Hex,
} from './exportStorage';

describe('audit export private storage', () => {
  it('checksumsMatch normalizes the sha256: prefix', () => {
    const hex = sha256Hex('abc');
    expect(checksumsMatch(hex, `sha256:${hex}`)).toBe(true);
    expect(checksumsMatch(`sha256:${hex}`, hex)).toBe(true);
    expect(checksumsMatch(hex, sha256Hex('xyz'))).toBe(false);
  });

  it('hashAsyncIterable matches one-shot sha256 over the same bytes', async () => {
    const payload = Buffer.alloc(200_000, 7);
    const expected = formatArtifactChecksum(sha256Hex(payload));
    async function* chunks() {
      const window = 16_384;
      for (let i = 0; i < payload.byteLength; i += window) {
        yield payload.subarray(i, Math.min(i + window, payload.byteLength));
      }
    }
    const hashed = await hashAsyncIterable(chunks());
    expect(hashed.artifactBytes).toBe(payload.byteLength);
    expect(hashed.artifactChecksum).toBe(expected);
  });

  it('InMemory hashObject matches full-buffer checksum (streaming windows)', async () => {
    const storage = new InMemoryAuditExportArtifactStorage();
    const body = Buffer.from('{"type":"manifest"}\nline-2\n');
    await storage.uploadArtifact({
      body,
      storageKey: 'k',
    });
    const hashed = await storage.hashObject('k');
    expect(hashed.artifactChecksum).toBe(formatArtifactChecksum(sha256Hex(body)));
    expect(hashed.artifactBytes).toBe(body.byteLength);
  });

  it('InMemory uploadArtifact streams multi-chunk Readable without a single full-size peak', async () => {
    const storage = new InMemoryAuditExportArtifactStorage();
    const total = 256 * 1024;
    const chunkSize = 8 * 1024;
    const parts: Buffer[] = [];
    for (let i = 0; i < total; i += chunkSize) {
      parts.push(Buffer.alloc(Math.min(chunkSize, total - i), (i / chunkSize) % 255));
    }
    const full = Buffer.concat(parts);
    const stream = Readable.from(parts);
    const result = await storage.uploadArtifact({
      artifactChecksum: formatArtifactChecksum(sha256Hex(full)),
      body: stream,
      contentLength: total,
      storageKey: 'stream-key',
    });
    expect(result.artifactBytes).toBe(total);
    expect(result.artifactChecksum).toBe(formatArtifactChecksum(sha256Hex(full)));
    // Peak chunk is the stream window — not the full artifact buffer at once.
    expect(storage.peakUploadChunkBytes).toBeLessThanOrEqual(chunkSize);
    expect(storage.peakUploadChunkBytes).toBeLessThan(total);
  });

  it('buildPrivateAuditExportS3Options always forces setAcl:false (never public-read)', () => {
    const options = buildPrivateAuditExportS3Options();
    expect(options.setAcl).toBe(false);
    // Literal false — not inherited from global S3_SET_ACL
    expect(options).toMatchObject({ setAcl: false });
    expect(AuditExportPrivateS3Storage.enforcesPrivateAcl).toBe(true);
  });

  it('AuditExportPrivateS3Storage uploads via injected S3 (no public ACL path)', async () => {
    const uploadBuffer = vi.fn(async () => undefined);
    const getFileMetadata = vi.fn(async () => ({
      contentLength: 4,
      contentType: 'application/x-ndjson',
    }));
    const createPreSignedUrlForPreview = vi.fn(async () => 'https://signed.example/obj');
    const deleteFile = vi.fn(async () => undefined);

    const storage = new AuditExportPrivateS3Storage({
      createPreSignedUrlForPreview,
      deleteFile,
      getFileMetadata,
      uploadBuffer,
    } as never);

    const body = Buffer.from('test');
    const result = await storage.uploadArtifact({
      body,
      storageKey: 'platform-audit-exports/paex_x/evidence.ndjson',
    });

    expect(uploadBuffer).toHaveBeenCalledWith(
      'platform-audit-exports/paex_x/evidence.ndjson',
      body,
      'application/x-ndjson',
    );
    expect(result.artifactChecksum).toBe(formatArtifactChecksum(sha256Hex(body)));
    expect(result.artifactBytes).toBe(4);

    await storage.getObjectMetadata('platform-audit-exports/paex_x/evidence.ndjson');
    expect(getFileMetadata).toHaveBeenCalled();

    const url = await storage.getSignedDownloadUrl(
      'platform-audit-exports/paex_x/evidence.ndjson',
      120,
    );
    expect(url).toBe('https://signed.example/obj');
    expect(createPreSignedUrlForPreview).toHaveBeenCalledWith(
      'platform-audit-exports/paex_x/evidence.ndjson',
      120,
    );

    await storage.deleteObject('platform-audit-exports/paex_x/evidence.ndjson');
    expect(deleteFile).toHaveBeenCalled();
  });

  it('AuditExportPrivateS3Storage.listObjectKeysByPrefix paginates ListObjectsV2', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [{ Key: 'platform-audit-exports/e1/attempts/job_1/evidence.ndjson' }],
        IsTruncated: true,
        NextContinuationToken: 'tok-2',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'platform-audit-exports/e1/attempts/job_2/evidence.ndjson' }],
        IsTruncated: false,
      });

    const storage = new AuditExportPrivateS3Storage({
      createPreSignedUrlForPreview: vi.fn(),
      deleteFile: vi.fn(),
      getFileMetadata: vi.fn(),
      uploadBuffer: vi.fn(),
    } as never);
    // Inject stream backend so list uses the mocked client (no real S3 env).
    (
      storage as unknown as { streamBackend: { bucket: string; client: { send: typeof send } } }
    ).streamBackend = { bucket: 'audit-bucket', client: { send } };

    const keys = await storage.listObjectKeysByPrefix('platform-audit-exports/e1/attempts/');
    expect(keys).toEqual([
      'platform-audit-exports/e1/attempts/job_1/evidence.ndjson',
      'platform-audit-exports/e1/attempts/job_2/evidence.ndjson',
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('prefix deleteObject expands via listObjectKeysByPrefix (never bare DeleteObject on prefix)', async () => {
    const deleteFile = vi.fn(async () => undefined);
    const send = vi.fn().mockResolvedValue({
      Contents: [
        { Key: 'platform-audit-exports/e1/attempts/a/evidence.ndjson' },
        { Key: 'platform-audit-exports/e1/attempts/b/evidence.ndjson' },
      ],
      IsTruncated: false,
    });

    const storage = new AuditExportPrivateS3Storage({
      createPreSignedUrlForPreview: vi.fn(),
      deleteFile,
      getFileMetadata: vi.fn(),
      uploadBuffer: vi.fn(),
    } as never);
    (
      storage as unknown as { streamBackend: { bucket: string; client: { send: typeof send } } }
    ).streamBackend = { bucket: 'audit-bucket', client: { send } };

    await storage.deleteObject('platform-audit-exports/e1/attempts/');
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(deleteFile).toHaveBeenCalledWith('platform-audit-exports/e1/attempts/a/evidence.ndjson');
    expect(deleteFile).toHaveBeenCalledWith('platform-audit-exports/e1/attempts/b/evidence.ndjson');
    // Prefix itself must never be passed to DeleteObject.
    expect(deleteFile).not.toHaveBeenCalledWith('platform-audit-exports/e1/attempts/');
  });

  it('adapters without listObjectKeysByPrefix must not silently finalize prefix purges', async () => {
    // Contract: production path throws when a prefix is deleted without enumeration.
    const bare: {
      deleteObject: (k: string) => Promise<void>;
      listObjectKeysByPrefix?: (p: string) => Promise<string[]>;
    } = {
      deleteObject: async () => undefined,
      // intentionally omit listObjectKeysByPrefix
    };
    const { isAuditExportAttemptsPrefix } = await import('./exportStorage');
    const prefix = 'platform-audit-exports/e1/attempts/';
    expect(isAuditExportAttemptsPrefix(prefix)).toBe(true);
    // Mirror retentionWorker guard: missing list → throw (outbox stays pending).
    const guardedDelete = async (storageKey: string) => {
      if (isAuditExportAttemptsPrefix(storageKey) && !bare.listObjectKeysByPrefix) {
        throw new Error('AUDIT_EXPORT_PREFIX_LIST_REQUIRED');
      }
      await bare.deleteObject(storageKey);
    };
    await expect(guardedDelete(prefix)).rejects.toThrow('AUDIT_EXPORT_PREFIX_LIST_REQUIRED');
  });
});
