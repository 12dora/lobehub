// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  AuditExportPrivateS3Storage,
  buildPrivateAuditExportS3Options,
  formatArtifactChecksum,
  sha256Hex,
  verifyArtifactChecksum,
} from './exportStorage';

describe('audit export private storage', () => {
  it('verifyArtifactChecksum accepts matching SHA-256 and rejects mismatch/missing', () => {
    const body = Buffer.from('{"type":"manifest"}\n');
    const good = formatArtifactChecksum(sha256Hex(body));
    expect(verifyArtifactChecksum(body, good)).toBe(true);
    expect(verifyArtifactChecksum(body, sha256Hex(body))).toBe(true); // bare hex form
    expect(verifyArtifactChecksum(body, formatArtifactChecksum(sha256Hex('other')))).toBe(false);
    expect(verifyArtifactChecksum(body, null)).toBe(false);
    expect(verifyArtifactChecksum(body, undefined)).toBe(false);
    expect(verifyArtifactChecksum(body, '')).toBe(false);
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
    const getFileByteArray = vi.fn(async () => new Uint8Array(Buffer.from('test')));
    const createPreSignedUrlForPreview = vi.fn(async () => 'https://signed.example/obj');
    const deleteFile = vi.fn(async () => undefined);

    const storage = new AuditExportPrivateS3Storage({
      createPreSignedUrlForPreview,
      deleteFile,
      getFileByteArray,
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
});
