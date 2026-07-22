// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensurePlatformAuditExportWorkerStarted: vi.fn(),
  ensurePlatformSecretRewrapWorkerStarted: vi.fn(),
}));

vi.mock('../jobs/secretRewrap', () => ({
  ensurePlatformSecretRewrapWorkerStarted: mocks.ensurePlatformSecretRewrapWorkerStarted,
}));

vi.mock('../jobs/auditExport', () => ({
  ensurePlatformAuditExportWorkerStarted: mocks.ensurePlatformAuditExportWorkerStarted,
}));

describe('platform persistent worker bootstrap', () => {
  beforeAll(async () => {
    await import('./platform');
  });

  it('registers the secret rewrap worker from the production platform bootstrap module', () => {
    expect(mocks.ensurePlatformSecretRewrapWorkerStarted).toHaveBeenCalledOnce();
  });

  it('registers the audit export worker from the production platform bootstrap module', () => {
    expect(mocks.ensurePlatformAuditExportWorkerStarted).toHaveBeenCalledOnce();
  });
});
