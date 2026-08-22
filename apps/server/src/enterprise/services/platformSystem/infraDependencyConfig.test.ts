// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { resolveFileS3Config } from '@/server/modules/S3/resolveFileS3Config';

import { PlatformSecretService } from '../../security/secret';
import {
  keyManagementHealth,
  mailHealth,
  objectStorageHealth,
  probeKeyManagement,
  resolveEmailConfig,
} from './infraDependencyConfig';

const FAKE_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

describe('resolveFileS3Config', () => {
  it('requires an endpoint the same way FileS3 does', () => {
    expect(
      resolveFileS3Config({
        S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        S3_BUCKET: 'files',
        S3_REGION: 'us-west-2',
        S3_SECRET_ACCESS_KEY: 'secret',
      }).kind,
    ).toBe('incomplete');
    expect(
      resolveFileS3Config({
        S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        S3_BUCKET: 'files',
        S3_ENDPOINT: 'https://s3.example.com',
        S3_SECRET_ACCESS_KEY: 'secret',
      }),
    ).toMatchObject({ kind: 'complete', region: 'us-east-1' });
  });
});

describe('resolveEmailConfig', () => {
  it('defaults an omitted provider to SMTP and requires user/password', () => {
    expect(resolveEmailConfig({ SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'a@b.com' })).toEqual({
      kind: 'incomplete',
      provider: 'smtp',
    });
    expect(
      resolveEmailConfig({
        SMTP_PASS: 'secret',
        SMTP_USER: 'smtp-user',
      }),
    ).toMatchObject({
      from: 'smtp-user',
      host: 'localhost',
      kind: 'smtp',
      port: 587,
      secure: false,
    });
  });

  it('uses Resend only when the provider is explicit', () => {
    expect(
      resolveEmailConfig({
        EMAIL_SERVICE_PROVIDER: 'resend',
        RESEND_API_KEY: 're_123',
        RESEND_FROM: 'a@b.com',
      }).kind,
    ).toBe('resend');
  });
});

describe('shared dependency health', () => {
  it('classifies object storage without an endpoint as incomplete', () => {
    expect(
      objectStorageHealth({
        S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        S3_BUCKET: 'files',
        S3_REGION: 'us-west-2',
        S3_SECRET_ACCESS_KEY: 'secret',
      }),
    ).toEqual({
      errorCategory: 'configuration_incomplete',
      lastCheckedAt: null,
      status: 'degraded',
    });
    expect(
      objectStorageHealth({
        S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        S3_BUCKET: 'files',
        S3_ENDPOINT: 'https://s3.example.com',
        S3_SECRET_ACCESS_KEY: 'secret',
      }),
    ).toEqual({
      errorCategory: 'passive_check_only',
      lastCheckedAt: null,
      status: 'unknown',
    });
  });

  it('treats omitted email provider plus credentials as configured SMTP', () => {
    expect(mailHealth({ SMTP_PASS: 'secret', SMTP_USER: 'smtp-user' })).toEqual({
      detail: 'SMTP localhost:587',
      errorCategory: 'passive_check_only',
      lastCheckedAt: null,
      status: 'unknown',
    });
    expect(
      mailHealth({
        SMTP_HOST: 'smtp.example.com',
        SMTP_PASS: 'secret',
        SMTP_PORT: '587',
        SMTP_USER: 'smtp-user',
      }),
    ).toMatchObject({ detail: 'SMTP smtp.example.com:587' });
    expect(
      mailHealth({
        EMAIL_SERVICE_PROVIDER: 'resend',
        RESEND_API_KEY: 're_123',
        RESEND_FROM: 'a@b.com',
      }),
    ).toEqual({
      detail: 'Resend',
      errorCategory: 'passive_check_only',
      lastCheckedAt: null,
      status: 'unknown',
    });
    expect(mailHealth({})).toEqual({
      errorCategory: null,
      lastCheckedAt: null,
      status: 'disabled',
    });
  });

  it('classifies key-management from tryFromEnv without probing', () => {
    expect(keyManagementHealth({})).toEqual({
      errorCategory: null,
      lastCheckedAt: null,
      status: 'disabled',
    });
    expect(keyManagementHealth({ PLATFORM_MASTER_KEY: FAKE_MASTER_KEY })).toEqual({
      detail: 'Environment master key',
      errorCategory: 'passive_check_only',
      lastCheckedAt: null,
      status: 'unknown',
    });
  });
});

describe('probeKeyManagement', () => {
  it('keeps disabled and incomplete branches and does not emit key material', async () => {
    expect(await probeKeyManagement({})).toEqual({
      errorCategory: null,
      lastCheckedAt: null,
      status: 'disabled',
    });
    expect(await probeKeyManagement({ PLATFORM_MASTER_KEY: 'not-valid-base64' })).toEqual({
      errorCategory: 'configuration_incomplete',
      lastCheckedAt: null,
      status: 'degraded',
    });
  });

  it('round-trips an env KEK and reports healthy without leaking the key id', async () => {
    const checkedAt = new Date('2026-08-18T00:00:00.000Z');
    const result = await probeKeyManagement(
      { PLATFORM_MASTER_KEY: FAKE_MASTER_KEY, PLATFORM_MASTER_KEY_ID: 'env:health' },
      () => checkedAt,
    );
    expect(result).toEqual({
      detail: 'Environment master key',
      errorCategory: null,
      lastCheckedAt: checkedAt,
      latencyMs: expect.any(Number),
      status: 'healthy',
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result)).not.toContain('env:health');
    expect(JSON.stringify(result)).not.toContain(FAKE_MASTER_KEY);
  });

  it('maps abort and vault timeout to timeout without leaking the address', async () => {
    vi.spyOn(PlatformSecretService, 'tryFromEnv').mockReturnValue({
      encrypt: vi.fn(),
      getActiveKeyId: async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
      keyProviderId: 'vault',
    } as never);

    const result = await probeKeyManagement({
      PLATFORM_KEY_PROVIDER: 'vault',
      VAULT_ADDR: 'https://vault.private.example',
      VAULT_TOKEN: 'secret-vault-token',
    });

    expect(result).toMatchObject({
      detail: 'Vault',
      errorCategory: 'timeout',
      latencyMs: expect.any(Number),
      status: 'unavailable',
    });
    expect(result.lastCheckedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(result)).not.toContain('vault.private.example');
    expect(JSON.stringify(result)).not.toContain('secret-vault-token');
    vi.restoreAllMocks();
  });

  it('maps other provider failures to operation_unavailable', async () => {
    vi.spyOn(PlatformSecretService, 'tryFromEnv').mockReturnValue({
      encrypt: vi.fn(),
      getActiveKeyId: async () => {
        throw new Error('Vault key material is unavailable');
      },
      keyProviderId: 'vault',
    } as never);

    await expect(
      probeKeyManagement({
        PLATFORM_KEY_PROVIDER: 'vault',
        VAULT_ADDR: 'https://vault.private.example',
        VAULT_TOKEN: 'secret-vault-token',
      }),
    ).resolves.toMatchObject({
      errorCategory: 'operation_unavailable',
      status: 'unavailable',
    });
    vi.restoreAllMocks();
  });
});
