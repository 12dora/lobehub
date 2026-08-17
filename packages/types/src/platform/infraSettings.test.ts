import { describe, expect, it } from 'vitest';

import {
  createDefaultMailConfig,
  createDefaultObjectStorageConfig,
  infraSecretActionSchema,
  mailPersistedSchema,
  mailUpdateSchema,
  normalizeMailConfig,
  normalizeObjectStorageConfig,
  objectStoragePersistedSchema,
  objectStorageUpdateSchema,
} from './infraSettings';

describe('infraSettings types', () => {
  it('defaults validate and are disabled', () => {
    const storage = createDefaultObjectStorageConfig();
    const mail = createDefaultMailConfig();
    expect(objectStoragePersistedSchema.parse(storage).enabled).toBe(false);
    expect(mailPersistedSchema.parse(mail)).toMatchObject({
      enabled: false,
      fromAddress: '',
      provider: 'smtp',
    });
  });

  it('normalizes unknown JSON to defaults', () => {
    expect(normalizeObjectStorageConfig(null).enabled).toBe(false);
    expect(normalizeObjectStorageConfig({ enabled: true, extra: 1 }).enabled).toBe(false);
    expect(
      normalizeMailConfig({ enabled: true, fromAddress: 'a@b.c', provider: 'resend' }),
    ).toEqual({
      enabled: true,
      fromAddress: 'a@b.c',
      provider: 'resend',
    });
  });

  it('accepts keep / clear / replace secret actions', () => {
    expect(infraSecretActionSchema.parse({ action: 'keep' })).toEqual({ action: 'keep' });
    expect(infraSecretActionSchema.parse({ action: 'clear' })).toEqual({ action: 'clear' });
    expect(infraSecretActionSchema.parse({ action: 'replace', value: 'secret' })).toEqual({
      action: 'replace',
      value: 'secret',
    });
    expect(infraSecretActionSchema.safeParse({ action: 'replace', value: '' }).success).toBe(false);
  });

  it('accepts a minimal disable payload and keeps constraints when fields are present', () => {
    expect(objectStorageUpdateSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(objectStorageUpdateSchema.parse({ enabled: false }).secretAccessKey).toEqual({
      action: 'keep',
    });
    expect(mailUpdateSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(objectStorageUpdateSchema.safeParse({ enabled: false, accessKeyId: '' }).success).toBe(
      false,
    );
    expect(
      objectStorageUpdateSchema.safeParse({ enabled: false, endpoint: 'not-a-url' }).success,
    ).toBe(false);
  });

  it('requires endpoint or region on object-storage update', () => {
    const base = {
      accessKeyId: 'AKIAEXAMPLE',
      bucket: 'files',
      enabled: true,
      forcePathStyle: false,
      secretAccessKey: { action: 'keep' as const },
      setAcl: false,
    };
    expect(objectStorageUpdateSchema.safeParse(base).success).toBe(false);
    expect(objectStorageUpdateSchema.safeParse({ ...base, region: 'us-west-2' }).success).toBe(
      true,
    );
    expect(
      objectStorageUpdateSchema.safeParse({
        ...base,
        endpoint: 'https://s3.example.com',
      }).success,
    ).toBe(true);
  });

  it('requires the matching mail provider block', () => {
    const smtp = {
      enabled: true,
      fromAddress: 'ops@example.com',
      provider: 'smtp' as const,
    };
    expect(mailUpdateSchema.safeParse(smtp).success).toBe(false);
    expect(
      mailUpdateSchema.safeParse({
        ...smtp,
        smtp: {
          host: 'smtp.example.com',
          pass: { action: 'keep' },
          port: 587,
          secure: false,
          user: 'ops',
        },
      }).success,
    ).toBe(true);
    expect(
      mailUpdateSchema.safeParse({
        enabled: true,
        fromAddress: 'ops@example.com',
        provider: 'resend',
      }).success,
    ).toBe(false);
    expect(
      mailUpdateSchema.safeParse({
        enabled: true,
        fromAddress: 'ops@example.com',
        provider: 'resend',
        resend: { apiKey: { action: 'replace', value: 're_xxx' } },
      }).success,
    ).toBe(true);
  });
});
