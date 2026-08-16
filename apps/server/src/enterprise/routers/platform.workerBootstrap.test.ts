// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  warnIfPlatformMasterKeyMissing: vi.fn(),
  ensureBrandingAssetCleanupWorkerStarted: vi.fn(),
  ensurePlatformAuditExportWorkerStarted: vi.fn(),
  ensurePlatformAuditRetentionWorkerStarted: vi.fn(),
  ensurePlatformSecretRewrapWorkerStarted: vi.fn(),
}));

vi.mock('../security/secret', () => ({
  warnIfPlatformMasterKeyMissing: mocks.warnIfPlatformMasterKeyMissing,
}));

vi.mock('../jobs/brandingAssetCleanup', () => ({
  ensureBrandingAssetCleanupWorkerStarted: mocks.ensureBrandingAssetCleanupWorkerStarted,
}));

vi.mock('../jobs/secretRewrap', () => ({
  ensurePlatformSecretRewrapWorkerStarted: mocks.ensurePlatformSecretRewrapWorkerStarted,
}));

vi.mock('../jobs/auditExport', () => ({
  ensurePlatformAuditExportWorkerStarted: mocks.ensurePlatformAuditExportWorkerStarted,
}));

vi.mock('../jobs/auditRetention', () => ({
  ensurePlatformAuditRetentionWorkerStarted: mocks.ensurePlatformAuditRetentionWorkerStarted,
}));

describe('platform persistent worker bootstrap', () => {
  beforeAll(async () => {
    await import('./platform');
  }, 30_000);

  it('registers the secret rewrap worker from the production platform bootstrap module', () => {
    expect(mocks.ensurePlatformSecretRewrapWorkerStarted).toHaveBeenCalledOnce();
  });

  it('reports the enterprise key provider status before production bootstrap completes', () => {
    // Warns instead of throwing: enterprise features are on by default, so a deployment
    // without PLATFORM_MASTER_KEY must still boot.
    expect(mocks.warnIfPlatformMasterKeyMissing).toHaveBeenCalledOnce();
  });

  it('registers the branding asset cleanup worker from the production platform bootstrap module', () => {
    expect(mocks.ensureBrandingAssetCleanupWorkerStarted).toHaveBeenCalledOnce();
  });

  it('registers the audit export worker from the production platform bootstrap module', () => {
    expect(mocks.ensurePlatformAuditExportWorkerStarted).toHaveBeenCalledOnce();
  });

  it('registers the audit retention worker from the production platform bootstrap module', () => {
    expect(mocks.ensurePlatformAuditRetentionWorkerStarted).toHaveBeenCalledOnce();
  });
});
