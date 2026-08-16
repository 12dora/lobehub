// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { resolveFileS3Config } from '@/server/modules/S3/resolveFileS3Config';

import {
  keyManagementHealth,
  mailHealth,
  objectStorageHealth,
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
    ).toEqual({ errorCategory: 'configuration_incomplete', status: 'degraded' });
  });

  it('treats omitted email provider plus credentials as configured SMTP', () => {
    expect(mailHealth({ SMTP_PASS: 'secret', SMTP_USER: 'smtp-user' })).toEqual({
      errorCategory: 'passive_check_only',
      status: 'unknown',
    });
  });

  it('keeps key-management health on tryFromEnv', () => {
    expect(keyManagementHealth({})).toEqual({ errorCategory: null, status: 'disabled' });
    expect(keyManagementHealth({ PLATFORM_MASTER_KEY: FAKE_MASTER_KEY })).toEqual({
      errorCategory: 'passive_check_only',
      status: 'unknown',
    });
  });
});
