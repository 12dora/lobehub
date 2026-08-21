import { beforeEach, describe, expect, it, vi } from 'vitest';

const getInfraSnapshot = vi.fn();

vi.mock('@/server/enterprise/services/infraSettings/snapshot', () => ({
  getInfraSnapshot: (...args: unknown[]) => getInfraSnapshot(...args),
}));

vi.mock('@/envs/app', () => ({
  appEnv: {
    APP_URL: 'https://app.example.com',
    INTERNAL_APP_URL: 'http://127.0.0.1:3010',
  },
}));

vi.mock('@/envs/file', () => ({
  fileEnv: {
    S3_BUCKET: 'env-bucket',
    S3_ENABLE_PATH_STYLE: true,
    S3_ENDPOINT: 'http://localhost:9000',
    S3_PUBLIC_DOMAIN: undefined,
  },
}));

describe('resolveOwnDeploymentOrigins', () => {
  beforeEach(() => {
    getInfraSnapshot.mockReset();
  });

  it('builds allowlist from the effective snapshot when it differs from env', async () => {
    getInfraSnapshot.mockResolvedValue({
      objectStorage: {
        bucket: 'prod-files',
        endpoint: 'https://s3.example.net',
        forcePathStyle: false,
        kind: 'complete',
        publicDomain: 'https://cdn.example.com',
      },
    });

    const { isOwnDeploymentFileUrl } = await import('@lobechat/utils');
    const { resolveOwnDeploymentOrigins } = await import('./ownDeploymentOrigins');
    const origins = await resolveOwnDeploymentOrigins();

    expect(isOwnDeploymentFileUrl('https://prod-files.s3.example.net/a.png', origins)).toBe(true);
    expect(isOwnDeploymentFileUrl('http://localhost:9000/env-bucket/a.png', origins)).toBe(false);
    expect(isOwnDeploymentFileUrl('https://app.example.com/f/abc', origins)).toBe(true);
    expect(isOwnDeploymentFileUrl('https://cdn.example.com/a.png', origins)).toBe(true);
  });

  it('falls back to env storage when the snapshot is unconfigured', async () => {
    getInfraSnapshot.mockResolvedValue({ objectStorage: { kind: 'unconfigured' } });

    const { isOwnDeploymentFileUrl } = await import('@lobechat/utils');
    const { resolveOwnDeploymentOrigins } = await import('./ownDeploymentOrigins');
    const origins = await resolveOwnDeploymentOrigins();

    expect(isOwnDeploymentFileUrl('http://localhost:9000/env-bucket/a.png', origins)).toBe(true);
    expect(isOwnDeploymentFileUrl('https://prod-files.s3.example.net/a.png', origins)).toBe(false);
  });
});
