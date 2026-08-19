// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { INFRA_SECRET_REUSE_MESSAGE } from './destinationTuple';
import { InfraSettingsSecretRequiredError, InfraSettingsSecretReuseError } from './errors';
import {
  applyMailUpdate,
  applyObjectStorageUpdate,
  summarizeMailAfterDiff,
  summarizeObjectStorageAfterDiff,
  toMailView,
  toObjectStorageView,
} from './settingsService';

vi.mock('./secrets', () => ({
  sealInfraSecret: vi.fn(async (plain: string) => `sealed:${plain}`),
}));

const storageBase = {
  accessKeyId: 'AKIAEXAMPLE',
  bucket: 'files',
  enabled: true,
  endpoint: 'https://s3.example.com',
  forcePathStyle: false,
  secretAccessKey: { action: 'replace' as const, value: 'super-secret' },
  setAcl: true,
};

describe('applyObjectStorageUpdate', () => {
  it('seals a replace action and keeps other fields', async () => {
    const next = await applyObjectStorageUpdate(undefined, storageBase);
    expect(next.secretAccessKeyCiphertext).toBe('sealed:super-secret');
    expect(next.bucket).toBe('files');
    expect(next.setAcl).toBe(true);
  });

  it('rejects enabling without a stored secret', async () => {
    await expect(
      applyObjectStorageUpdate(undefined, {
        ...storageBase,
        secretAccessKey: { action: 'keep' },
      }),
    ).rejects.toBeInstanceOf(InfraSettingsSecretRequiredError);

    await expect(
      applyObjectStorageUpdate(
        { enabled: false, forcePathStyle: false, setAcl: false },
        {
          ...storageBase,
          secretAccessKey: { action: 'clear' },
        },
      ),
    ).rejects.toMatchObject({ field: 'secretAccessKey' });
  });

  it('keeps the previous ciphertext on keep when the destination tuple is unchanged', async () => {
    const next = await applyObjectStorageUpdate(
      {
        bucket: 'files',
        enabled: true,
        endpoint: 'https://s3.example.com',
        forcePathStyle: false,
        secretAccessKeyCiphertext: 'sealed:old',
        setAcl: false,
      },
      { ...storageBase, secretAccessKey: { action: 'keep' } },
    );
    expect(next.secretAccessKeyCiphertext).toBe('sealed:old');
  });

  it('disables with a minimal payload and keeps stored non-secret fields', async () => {
    const next = await applyObjectStorageUpdate(
      {
        accessKeyId: 'AKIASTOREDKEY',
        bucket: 'kept-bucket',
        enabled: true,
        endpoint: 'https://s3.example.com',
        forcePathStyle: true,
        publicDomain: 'https://cdn.example.com',
        region: 'us-west-2',
        secretAccessKeyCiphertext: 'sealed:undecryptable',
        setAcl: true,
      },
      { enabled: false },
    );
    expect(next).toEqual({
      accessKeyId: 'AKIASTOREDKEY',
      bucket: 'kept-bucket',
      enabled: false,
      endpoint: 'https://s3.example.com',
      forcePathStyle: true,
      publicDomain: 'https://cdn.example.com',
      region: 'us-west-2',
      secretAccessKeyCiphertext: 'sealed:undecryptable',
      setAcl: true,
    });
  });

  it('clears the secret on disable without blanking stored non-secret fields', async () => {
    const next = await applyObjectStorageUpdate(
      {
        accessKeyId: 'AKIASTOREDKEY',
        bucket: 'kept-bucket',
        enabled: true,
        endpoint: 'https://s3.example.com',
        forcePathStyle: false,
        secretAccessKeyCiphertext: 'sealed:old',
        setAcl: false,
      },
      { enabled: false, secretAccessKey: { action: 'clear' } },
    );
    expect(next.secretAccessKeyCiphertext).toBeUndefined();
    expect(next.accessKeyId).toBe('AKIASTOREDKEY');
    expect(next.bucket).toBe('kept-bucket');
    expect(next.endpoint).toBe('https://s3.example.com');
  });

  it('rejects keep when the object-storage destination tuple changes', async () => {
    await expect(
      applyObjectStorageUpdate(
        {
          bucket: 'files',
          enabled: true,
          endpoint: 'https://s3.example.com',
          forcePathStyle: false,
          secretAccessKeyCiphertext: 'sealed:old',
          setAcl: false,
        },
        {
          ...storageBase,
          endpoint: 'https://attacker.example',
          secretAccessKey: { action: 'keep' },
        },
      ),
    ).rejects.toMatchObject({
      field: 'secretAccessKey',
      message: INFRA_SECRET_REUSE_MESSAGE,
      name: 'InfraSettingsSecretReuseError',
    });
  });

  it('keeps ciphertext on disable + keep even when bucket and endpoint change', async () => {
    const next = await applyObjectStorageUpdate(
      {
        bucket: 'files',
        enabled: true,
        endpoint: 'https://s3.example.com',
        forcePathStyle: false,
        secretAccessKeyCiphertext: 'sealed:old',
        setAcl: false,
      },
      {
        bucket: 'other-bucket',
        enabled: false,
        endpoint: 'https://attacker.example.com',
        secretAccessKey: { action: 'keep' },
      },
    );
    expect(next.secretAccessKeyCiphertext).toBe('sealed:old');
    expect(next.bucket).toBe('other-bucket');
    expect(next.endpoint).toBe('https://attacker.example.com');
  });
});

describe('applyMailUpdate', () => {
  it('rejects enabling SMTP without a stored password', async () => {
    await expect(
      applyMailUpdate(undefined, {
        enabled: true,
        fromAddress: 'ops@example.com',
        provider: 'smtp',
        smtp: {
          host: 'smtp.example.com',
          pass: { action: 'keep' },
          port: 587,
          secure: false,
          user: 'ops',
        },
      }),
    ).rejects.toMatchObject({ field: 'smtp.pass' });
  });

  it('rejects keep when the SMTP host changes', async () => {
    await expect(
      applyMailUpdate(
        {
          enabled: true,
          fromAddress: 'ops@example.com',
          provider: 'smtp',
          smtp: {
            host: 'smtp.example.com',
            passCiphertext: 'sealed:pass',
            port: 587,
            secure: false,
            user: 'ops',
          },
        },
        {
          enabled: true,
          fromAddress: 'ops@example.com',
          provider: 'smtp',
          smtp: {
            host: 'attacker.example',
            pass: { action: 'keep' },
            port: 587,
            secure: false,
            user: 'ops',
          },
        },
      ),
    ).rejects.toBeInstanceOf(InfraSettingsSecretReuseError);
  });

  it('disables SMTP with a minimal payload and keeps stored non-secret fields', async () => {
    const next = await applyMailUpdate(
      {
        enabled: true,
        fromAddress: 'ops@example.com',
        provider: 'smtp',
        senderName: 'Ops',
        smtp: {
          host: 'smtp.example.com',
          passCiphertext: 'sealed:undecryptable',
          port: 465,
          secure: true,
          user: 'ops',
        },
      },
      { enabled: false },
    );
    expect(next).toEqual({
      enabled: false,
      fromAddress: 'ops@example.com',
      provider: 'smtp',
      senderName: 'Ops',
      smtp: {
        host: 'smtp.example.com',
        passCiphertext: 'sealed:undecryptable',
        port: 465,
        secure: true,
        user: 'ops',
      },
    });
  });

  it('seals a resend API key replace', async () => {
    const next = await applyMailUpdate(undefined, {
      enabled: true,
      fromAddress: 'ops@example.com',
      provider: 'resend',
      resend: { apiKey: { action: 'replace', value: 're_xxx' } },
    });
    expect(next.resend?.apiKeyCiphertext).toBe('sealed:re_xxx');
  });

  it('keeps the previous SMTP password when enabling with an unchanged destination', async () => {
    const next = await applyMailUpdate(
      {
        enabled: true,
        fromAddress: 'ops@example.com',
        provider: 'smtp',
        smtp: {
          host: 'smtp.example.com',
          passCiphertext: 'sealed:pass',
          port: 587,
          secure: false,
          user: 'ops',
        },
      },
      {
        enabled: true,
        fromAddress: 'ops@example.com',
        provider: 'smtp',
        smtp: {
          host: 'smtp.example.com',
          pass: { action: 'keep' },
          port: 587,
          secure: false,
          user: 'ops',
        },
      },
    );
    expect(next.smtp?.passCiphertext).toBe('sealed:pass');
  });

  it('seals a replace SMTP password without a reuse check', async () => {
    const next = await applyMailUpdate(
      {
        enabled: true,
        fromAddress: 'ops@example.com',
        provider: 'smtp',
        smtp: {
          host: 'smtp.example.com',
          passCiphertext: 'sealed:old',
          port: 587,
          secure: false,
          user: 'ops',
        },
      },
      {
        enabled: true,
        fromAddress: 'ops@example.com',
        provider: 'smtp',
        smtp: {
          host: 'attacker.example',
          pass: { action: 'replace', value: 'new-pass' },
          port: 587,
          secure: false,
          user: 'ops',
        },
      },
    );
    expect(next.smtp?.passCiphertext).toBe('sealed:new-pass');
  });

  it('rejects enabling Resend without a stored API key', async () => {
    await expect(
      applyMailUpdate(undefined, {
        enabled: true,
        fromAddress: 'ops@example.com',
        provider: 'resend',
        resend: { apiKey: { action: 'keep' } },
      }),
    ).rejects.toMatchObject({ field: 'resend.apiKey' });
  });

  it('rejects keep when enabling Resend after a stored SMTP destination', async () => {
    await expect(
      applyMailUpdate(
        {
          enabled: true,
          fromAddress: 'ops@example.com',
          provider: 'smtp',
          resend: { apiKeyCiphertext: 'sealed:re_old' },
          smtp: {
            host: 'smtp.example.com',
            passCiphertext: 'sealed:pass',
            port: 587,
            secure: false,
            user: 'ops',
          },
        },
        {
          enabled: true,
          fromAddress: 'ops@example.com',
          provider: 'resend',
          resend: { apiKey: { action: 'keep' } },
        },
      ),
    ).rejects.toMatchObject({
      field: 'apiKey',
      message: INFRA_SECRET_REUSE_MESSAGE,
      name: 'InfraSettingsSecretReuseError',
    });
  });

  it('clears the SMTP password on disable without blanking host and user', async () => {
    const next = await applyMailUpdate(
      {
        enabled: true,
        fromAddress: 'ops@example.com',
        provider: 'smtp',
        smtp: {
          host: 'smtp.example.com',
          passCiphertext: 'sealed:pass',
          port: 587,
          secure: false,
          user: 'ops',
        },
      },
      { enabled: false, smtp: { pass: { action: 'clear' } } },
    );
    expect(next.smtp?.passCiphertext).toBeUndefined();
    expect(next.smtp?.host).toBe('smtp.example.com');
    expect(next.smtp?.user).toBe('ops');
  });

  it('keeps the Resend API key on disable without a reuse check', async () => {
    const next = await applyMailUpdate(
      {
        enabled: true,
        fromAddress: 'ops@example.com',
        provider: 'resend',
        resend: { apiKeyCiphertext: 'sealed:re_old' },
      },
      { enabled: false, resend: { apiKey: { action: 'keep' } } },
    );
    expect(next.resend?.apiKeyCiphertext).toBe('sealed:re_old');
  });
});

describe('view + afterDiff redaction', () => {
  it('never includes ciphertext in the view or afterDiff', () => {
    const config = {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      bucket: 'files',
      enabled: true,
      endpoint: 'https://s3.example.com',
      forcePathStyle: true,
      publicDomain: 'https://cdn.example.com',
      region: 'us-west-2',
      secretAccessKeyCiphertext: 'aihub.secret.v1.ciphertext',
      setAcl: false,
    };
    const view = toObjectStorageView(config);
    expect(view.hasSecretAccessKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain('ciphertext');

    const diff = summarizeObjectStorageAfterDiff(config, true);
    expect(diff).toEqual({
      accessKeyIdMasked: 'AKIA****MPLE',
      bucket: 'files',
      enabled: true,
      endpoint: 'https://s3.example.com',
      forcePathStyle: true,
      publicDomain: 'https://cdn.example.com',
      region: 'us-west-2',
      secretChanged: true,
      setAcl: false,
    });
    expect(JSON.stringify(diff)).not.toContain('ciphertext');
    expect(JSON.stringify(diff)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts mail afterDiff to non-secret fields', () => {
    const config = {
      enabled: true,
      fromAddress: 'ops@example.com',
      provider: 'smtp' as const,
      senderName: 'Ops',
      smtp: {
        host: 'smtp.example.com',
        passCiphertext: 'sealed:pass',
        port: 465,
        secure: true,
        user: 'ops',
      },
    };
    expect(toMailView(config).hasSmtpPass).toBe(true);
    const diff = summarizeMailAfterDiff(config, false);
    expect(diff).toEqual({
      enabled: true,
      fromAddress: 'ops@example.com',
      host: 'smtp.example.com',
      port: 465,
      provider: 'smtp',
      secretChanged: false,
      secure: true,
      senderName: 'Ops',
      user: 'ops',
    });
    expect(JSON.stringify(diff)).not.toContain('sealed');
  });
});
