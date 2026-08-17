// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const snapshot = vi.hoisted(() => ({
  fingerprint: 'fp-1',
  getInfraSnapshot: vi.fn(),
}));

vi.mock('@/server/enterprise/services/infraSettings/snapshot', () => ({
  getInfraSnapshot: snapshot.getInfraSnapshot,
}));

vi.mock('@/envs/file', () => ({
  fileEnv: {
    S3_ACCESS_KEY_ID: 'AKIA',
    S3_BUCKET: 'bucket',
    S3_ENABLE_PATH_STYLE: false,
    S3_ENDPOINT: 'https://s3.example.com',
    S3_PREVIEW_URL_EXPIRE_IN: 7200,
    S3_PUBLIC_DOMAIN: undefined,
    S3_REGION: 'us-east-1',
    S3_SECRET_ACCESS_KEY: 'secret',
    S3_SET_ACL: false,
  },
}));

const complete = {
  accessKeyId: 'AKIA',
  bucket: 'bucket',
  endpoint: 'https://s3.example.com',
  forcePathStyle: false,
  kind: 'complete' as const,
  previewUrlExpireIn: 7200,
  publicDomain: undefined,
  region: 'us-east-1',
  secretAccessKey: 'secret',
  setAcl: false,
  source: 'env' as const,
};

describe('createFileS3 memo', () => {
  afterEach(async () => {
    const { resetCreateFileS3ForTest } = await import('./index');
    resetCreateFileS3ForTest();
    snapshot.fingerprint = 'fp-1';
    vi.resetModules();
  });

  it('reuses the client until the snapshot fingerprint changes', async () => {
    snapshot.getInfraSnapshot.mockImplementation(async () => ({
      fingerprint: snapshot.fingerprint,
      loadedAt: Date.now(),
      mail: { kind: 'unconfigured', source: 'env' },
      mailRevision: 0,
      objectStorage: complete,
      objectStorageRevision: 0,
    }));
    const { createFileS3 } = await import('./index');
    const first = await createFileS3();
    const second = await createFileS3();
    expect(second).toBe(first);

    snapshot.fingerprint = 'fp-2';
    const third = await createFileS3();
    expect(third).not.toBe(first);
  });
});
