// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { adminSystemGetInfraSettingsOutputSchema } from '@/server/enterprise/contracts/adminSystem';

import { InfraSettingsService, maskAccessId, parseFromField } from './infraSettingsService';

const FAKE_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const SECRET_VALUES = [
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  'smtp-super-secret-pass',
  're_1234567890secret',
  FAKE_MASTER_KEY,
  'vault-root-token',
];

const completeS3Env = {
  S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  S3_BUCKET: 'platform-files',
  S3_ENDPOINT: 'https://s3.internal.example',
  S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

describe('infra settings masking helpers', () => {
  it('masks access ids without echoing the secret tail in full', () => {
    expect(maskAccessId('AKIAIOSFODNN7EXAMPLE')).toBe('AKIA****MPLE');
    expect(maskAccessId('abcd')).toBe('****');
    expect(maskAccessId(undefined)).toBeNull();
  });

  it('parses a display name from an RFC 5322 from field', () => {
    expect(parseFromField('"Platform Mail" <noreply@example.com>')).toEqual({
      address: 'noreply@example.com',
      senderName: 'Platform Mail',
    });
    expect(parseFromField('noreply@example.com')).toEqual({
      address: 'noreply@example.com',
      senderName: null,
    });
  });
});

describe('InfraSettingsService.getInfraSettings', () => {
  it('returns the effective masked configuration and never leaks raw secrets', () => {
    const now = new Date('2026-08-17T12:00:00.000Z');
    const settings = new InfraSettingsService({
      env: {
        EMAIL_SERVICE_PROVIDER: 'nodemailer',
        PLATFORM_KEY_PROVIDER: 'vault',
        PLATFORM_MASTER_KEY: FAKE_MASTER_KEY,
        PLATFORM_MASTER_KEY_ID: 'vault:active',
        RESEND_API_KEY: 're_1234567890secret',
        S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        S3_BUCKET: 'platform-files',
        S3_ENABLE_PATH_STYLE: '1',
        S3_ENDPOINT: 'https://s3.internal.example',
        S3_PUBLIC_DOMAIN: 'https://cdn.example.com',
        S3_REGION: 'us-west-2',
        S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        SMTP_FROM: '"Alerts" <alerts@example.com>',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PASS: 'smtp-super-secret-pass',
        SMTP_PORT: '465',
        SMTP_SECURE: 'true',
        SMTP_USER: 'smtp-user',
        VAULT_ADDR: 'https://vault.internal.example',
        VAULT_TOKEN: 'vault-root-token',
      },
      now: () => now,
    }).getInfraSettings();

    expect(() => adminSystemGetInfraSettingsOutputSchema.parse(settings)).not.toThrow();
    expect(settings).toMatchObject({
      keyManagement: {
        keyId: null,
        masterKeyConfigured: true,
        provider: 'vault',
        vaultAddress: 'https://vault.internal.example',
      },
      mail: {
        fromAddress: 'alerts@example.com',
        host: 'smtp.example.com',
        port: 465,
        provider: 'smtp',
        secure: true,
        senderName: 'Alerts',
      },
      objectStorage: {
        accessId: 'AKIA****MPLE',
        bucket: 'platform-files',
        endpoint: 'https://s3.internal.example',
        pathStyle: true,
        publicDomain: 'https://cdn.example.com',
        region: 'us-west-2',
      },
      snapshotAt: now,
    });

    const serialized = JSON.stringify(settings);
    for (const secret of SECRET_VALUES) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(serialized).not.toContain('vault:active');
  });

  it('exposes FileS3 and EmailService defaults for complete env-only configs', () => {
    const settings = new InfraSettingsService({
      env: {
        ...completeS3Env,
        SMTP_PASS: 'smtp-super-secret-pass',
        SMTP_USER: 'smtp-user',
      },
    }).getInfraSettings();

    expect(settings.objectStorage.region).toBe('us-east-1');
    expect(settings.mail).toMatchObject({
      fromAddress: 'smtp-user',
      host: 'localhost',
      port: 587,
      provider: 'smtp',
      secure: false,
    });
  });

  it('reports unconfigured dependencies without inventing values', () => {
    const settings = new InfraSettingsService({ env: {} }).getInfraSettings();
    expect(settings.objectStorage).toMatchObject({
      accessId: null,
      bucket: null,
      region: null,
      status: 'disabled',
    });
    expect(settings.mail).toMatchObject({
      fromAddress: null,
      provider: 'unconfigured',
      status: 'disabled',
    });
    expect(settings.keyManagement).toMatchObject({
      masterKeyConfigured: false,
      provider: 'unconfigured',
      status: 'disabled',
    });
  });
});

describe('InfraSettingsService.testDependency factories', () => {
  it('runs HeadBucket, falls back to ListObjects, and always destroys the client', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('not implemented'), { name: 'NotImplemented' }),
      )
      .mockResolvedValueOnce({});
    const destroy = vi.fn();
    const result = await new InfraSettingsService({
      createS3Client: () => ({ destroy, send }),
      env: completeS3Env,
      now: () => new Date('2026-08-17T12:00:01.000Z'),
    }).testDependency({ dependency: 'objectStorage' });

    expect(result).toEqual({
      checkedAt: new Date('2026-08-17T12:00:01.000Z'),
      latencyMs: expect.any(Number),
      ok: true,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('wJalrXUtnFEMI');
  });

  it('classifies S3 auth failure and still destroys the client', async () => {
    const destroy = vi.fn();
    const result = await new InfraSettingsService({
      createS3Client: () => ({
        destroy,
        send: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' })),
      }),
      env: completeS3Env,
    }).testDependency({ dependency: 'objectStorage' });

    expect(result).toMatchObject({ message: 'unauthorized', ok: false });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('rejects object storage without an endpoint even when a region is set', async () => {
    const createS3Client = vi.fn();
    const result = await new InfraSettingsService({
      createS3Client,
      env: {
        S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        S3_BUCKET: 'platform-files',
        S3_REGION: 'us-west-2',
        S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
    }).testDependency({ dependency: 'objectStorage' });

    expect(result).toMatchObject({ message: 'configuration_incomplete', ok: false });
    expect(createS3Client).not.toHaveBeenCalled();
  });

  it('verifies SMTP and closes the transporter', async () => {
    const verify = vi.fn().mockResolvedValue(true);
    const close = vi.fn();
    const result = await new InfraSettingsService({
      createMailTransport: () => ({ close, verify }),
      env: { SMTP_PASS: 'smtp-super-secret-pass', SMTP_USER: 'smtp-user' },
    }).testDependency({ dependency: 'mail' });

    expect(result.ok).toBe(true);
    expect(verify).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('maps SMTP verify timeout to a stable reason without leaking the host', async () => {
    const result = await new InfraSettingsService({
      createMailTransport: () => ({
        close: vi.fn(),
        verify: vi.fn().mockRejectedValue(new Error('timeout connecting to smtp.internal.example')),
      }),
      env: { SMTP_PASS: 'smtp-super-secret-pass', SMTP_USER: 'smtp-user' },
    }).testDependency({ dependency: 'mail' });

    expect(result).toMatchObject({ message: 'timeout', ok: false });
    expect(JSON.stringify(result)).not.toContain('smtp.internal.example');
    expect(JSON.stringify(result)).not.toContain('smtp-super-secret-pass');
  });

  it('treats a failed Resend GET as unreachable, not success', async () => {
    const result = await new InfraSettingsService({
      env: {
        EMAIL_SERVICE_PROVIDER: 'resend',
        RESEND_API_KEY: 're_1234567890secret',
        RESEND_FROM: 'a@b.com',
      },
      outboundFetch: async () => {
        throw new Error('ECONNREFUSED api.resend.com');
      },
    }).testDependency({ dependency: 'mail' });

    expect(result).toMatchObject({ message: 'unreachable', ok: false });
    expect(JSON.stringify(result)).not.toContain('re_1234567890secret');
  });

  it('classifies Resend 401 as unauthorized', async () => {
    const result = await new InfraSettingsService({
      env: {
        EMAIL_SERVICE_PROVIDER: 'resend',
        RESEND_API_KEY: 're_1234567890secret',
        RESEND_FROM: 'a@b.com',
      },
      outboundFetch: async () => ({ ok: false, status: 401 }),
    }).testDependency({ dependency: 'mail' });

    expect(result).toMatchObject({ message: 'unauthorized', ok: false });
  });

  it('validates the configured master key through getActiveKeyId', async () => {
    const getActiveKeyId = vi.fn().mockResolvedValue('vault:live');
    const result = await new InfraSettingsService({
      env: { PLATFORM_KEY_PROVIDER: 'vault', VAULT_TOKEN: 'vault-root-token' },
      secretServiceFromEnv: () => ({ getActiveKeyId }),
    }).testDependency({ dependency: 'keyManagement' });

    expect(result.ok).toBe(true);
    expect(getActiveKeyId).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('vault-root-token');
  });

  it('fails closed when secret management is missing', async () => {
    const result = await new InfraSettingsService({
      env: {},
    }).testDependency({ dependency: 'keyManagement' });

    expect(result).toMatchObject({ message: 'not_configured', ok: false });
  });
});
