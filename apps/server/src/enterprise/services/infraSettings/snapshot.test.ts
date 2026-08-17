// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetInfraSnapshotForTest } from './snapshot';

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => {
    throw new Error('db unavailable');
  }),
}));

vi.mock('@/envs/file', () => ({
  fileEnv: {
    S3_ACCESS_KEY_ID: 'AKIAENV',
    S3_BUCKET: 'env-bucket',
    S3_ENABLE_PATH_STYLE: false,
    S3_ENDPOINT: 'https://s3.env.example',
    S3_PREVIEW_URL_EXPIRE_IN: 7200,
    S3_PUBLIC_DOMAIN: undefined,
    S3_REGION: 'us-east-1',
    S3_SECRET_ACCESS_KEY: 'env-secret',
    S3_SET_ACL: false,
  },
}));

vi.mock('@/envs/email', () => ({
  emailEnv: {
    EMAIL_SERVICE_PROVIDER: undefined,
    RESEND_API_KEY: undefined,
    RESEND_FROM: undefined,
    SMTP_FROM: undefined,
    SMTP_HOST: undefined,
    SMTP_PASS: undefined,
    SMTP_PORT: undefined,
    SMTP_SECURE: false,
    SMTP_USER: undefined,
  },
}));

describe('getInfraSnapshot fail-open', () => {
  afterEach(() => {
    resetInfraSnapshotForTest();
    vi.restoreAllMocks();
  });

  it('serves the env bag when the database cannot be reached', async () => {
    const { getInfraSnapshot } = await import('./snapshot');
    const snapshot = await getInfraSnapshot();
    expect(snapshot.objectStorage).toMatchObject({
      bucket: 'env-bucket',
      kind: 'complete',
      source: 'env',
    });
    expect(snapshot.mail.source).toBe('env');
    expect(snapshot.fingerprint).toEqual(expect.any(String));
  });
});
