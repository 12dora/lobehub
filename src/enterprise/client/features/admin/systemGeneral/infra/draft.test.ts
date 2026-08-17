import { describe, expect, it } from 'vitest';

import {
  deriveSecretAction,
  fingerprintObjectStorageDraft,
  type MailDraft,
  type ObjectStorageDraft,
  settleMailDraft,
  settleObjectStorageDraft,
  toMailConfig,
  toMailDisableConfig,
  toMailDraft,
  toObjectStorageConfig,
  toObjectStorageDisableConfig,
  toObjectStorageDraft,
  validateMailDraft,
  validateObjectStorageDraft,
} from './draft';
import type { InfraMailView, InfraObjectStorageView } from './types';

const objectStorageView = (
  overrides: Partial<InfraObjectStorageView> = {},
): InfraObjectStorageView => ({
  accessId: 'AKIAFULLVALUE',
  errorCategory: null,
  status: 'unknown',
  bucket: 'files',
  enabled: true,
  endpoint: 'https://s3.example.com',
  hasSecretAccessKey: true,
  pathStyle: true,
  previewUrlExpireIn: 7200,
  publicDomain: null,
  region: 'us-east-1',
  revision: 3,
  setAcl: false,
  source: 'db',
  ...overrides,
});

const mailView = (overrides: Partial<InfraMailView> = {}): InfraMailView => ({
  enabled: true,
  errorCategory: null,
  fromAddress: 'noreply@example.com',
  hasResendApiKey: false,
  hasSmtpPass: true,
  host: 'smtp.example.com',
  port: 587,
  provider: 'smtp',
  revision: 2,
  secure: true,
  senderName: 'Platform',
  smtpUser: 'mailer',
  source: 'db',
  status: 'unknown',
  ...overrides,
});

const validObjectStorageDraft = (): ObjectStorageDraft => toObjectStorageDraft(objectStorageView());

const validMailDraft = (): MailDraft => toMailDraft(mailView());

describe('toObjectStorageDraft', () => {
  it('seeds every field from a configuration that is already managed here', () => {
    expect(toObjectStorageDraft(objectStorageView())).toMatchObject({
      accessKeyId: 'AKIAFULLVALUE',
      bucket: 'files',
      endpoint: 'https://s3.example.com',
      forcePathStyle: true,
      previewUrlExpireIn: '7200',
      region: 'us-east-1',
      secretAccessKey: { cleared: false, stored: true, value: '' },
    });
  });

  it('leaves the optional preview lifetime blank rather than printing a placeholder', () => {
    expect(
      toObjectStorageDraft(objectStorageView({ previewUrlExpireIn: null })).previewUrlExpireIn,
    ).toBe('');
  });

  it('drops the masked access key and the secret when the values come from the environment', () => {
    const draft = toObjectStorageDraft(
      objectStorageView({ accessId: 'AKIA****MPLE', source: 'env' }),
    );

    expect(draft.accessKeyId).toBe('');
    expect(draft.secretAccessKey).toEqual({ cleared: false, stored: false, value: '' });
    // Non-secret values are still worth prefilling.
    expect(draft.bucket).toBe('files');
  });
});

describe('toMailDraft', () => {
  it('marks only the secrets of the selected provider as stored', () => {
    const draft = toMailDraft(mailView());

    expect(draft.pass.stored).toBe(true);
    expect(draft.resendApiKey.stored).toBe(false);
    expect(draft.port).toBe('587');
    expect(draft.user).toBe('mailer');
  });

  it('treats an environment-sourced password as absent', () => {
    expect(toMailDraft(mailView({ source: 'env' })).pass.stored).toBe(false);
  });

  it('falls back to SMTP when the dependency is not configured at all', () => {
    expect(toMailDraft(mailView({ port: null, provider: 'unconfigured' })).provider).toBe('smtp');
  });
});

describe('deriveSecretAction', () => {
  it('replaces when a value was typed, even after a clear was toggled', () => {
    expect(deriveSecretAction({ cleared: true, stored: true, value: 'next' })).toEqual({
      action: 'replace',
      value: 'next',
    });
  });

  it('clears on an explicit clear with no typed value', () => {
    expect(deriveSecretAction({ cleared: true, stored: true, value: '' })).toEqual({
      action: 'clear',
    });
  });

  it('keeps the stored secret when the field is left blank', () => {
    expect(deriveSecretAction({ cleared: false, stored: true, value: '' })).toEqual({
      action: 'keep',
    });
  });
});

describe('settle helpers', () => {
  it('drops the plaintext and remembers that a secret now exists', () => {
    const settled = settleObjectStorageDraft({
      ...validObjectStorageDraft(),
      secretAccessKey: { cleared: false, stored: false, value: 'typed' },
    });

    expect(settled.secretAccessKey).toEqual({ cleared: false, stored: true, value: '' });
  });

  it('remembers that a cleared secret is gone', () => {
    const settled = settleMailDraft({
      ...validMailDraft(),
      pass: { cleared: true, stored: true, value: '' },
    });

    expect(settled.pass).toEqual({ cleared: false, stored: false, value: '' });
  });
});

describe('validateObjectStorageDraft', () => {
  it('accepts a complete configuration', () => {
    expect(validateObjectStorageDraft(validObjectStorageDraft())).toEqual({});
  });

  it('requires an endpoint or a region', () => {
    const draft = { ...validObjectStorageDraft(), endpoint: '', region: '' };
    expect(validateObjectStorageDraft(draft).endpoint).toBe('endpointOrRegion');
  });

  it('accepts a region-only configuration (AWS)', () => {
    const draft = { ...validObjectStorageDraft(), endpoint: '' };
    expect(validateObjectStorageDraft(draft)).toEqual({});
  });

  it('rejects a non-http endpoint and a non-http public domain', () => {
    const draft = {
      ...validObjectStorageDraft(),
      endpoint: 'not a url',
      publicDomain: 'ftp://files.example.com',
    };
    const errors = validateObjectStorageDraft(draft);

    expect(errors.endpoint).toBe('url');
    expect(errors.publicDomain).toBe('url');
  });

  it('requires the bucket, the access key and a secret', () => {
    const errors = validateObjectStorageDraft({
      ...validObjectStorageDraft(),
      accessKeyId: '  ',
      bucket: '',
      secretAccessKey: { cleared: false, stored: false, value: '' },
    });

    expect(errors).toMatchObject({
      accessKeyId: 'required',
      bucket: 'required',
      secretAccessKey: 'secretRequired',
    });
  });

  it('rejects a credential longer than the contract allows', () => {
    const errors = validateObjectStorageDraft({
      ...validObjectStorageDraft(),
      secretAccessKey: { cleared: false, stored: true, value: 'x'.repeat(513) },
    });
    expect(errors.secretAccessKey).toBe('secretTooLong');
  });

  it('requires the credential again once the destination moved', () => {
    const baseline = validObjectStorageDraft();
    for (const moved of [
      { bucket: 'other-bucket' },
      { endpoint: 'https://s3.other.example.com' },
      { region: 'eu-west-1' },
    ]) {
      expect(validateObjectStorageDraft({ ...baseline, ...moved }, baseline).secretAccessKey).toBe(
        'secretReenterRequired',
      );
    }
  });

  it('accepts a kept credential when only non-destination fields changed', () => {
    const baseline = validObjectStorageDraft();
    expect(
      validateObjectStorageDraft(
        { ...baseline, publicDomain: 'https://files.example.com', setAcl: true },
        baseline,
      ),
    ).toEqual({});
  });

  it('accepts a moved destination once a new credential is typed', () => {
    const baseline = validObjectStorageDraft();
    expect(
      validateObjectStorageDraft(
        {
          ...baseline,
          bucket: 'other-bucket',
          secretAccessKey: { cleared: false, stored: true, value: 'fresh' },
        },
        baseline,
      ),
    ).toEqual({});
  });

  it('rejects a preview lifetime outside the accepted range', () => {
    expect(
      validateObjectStorageDraft({ ...validObjectStorageDraft(), previewUrlExpireIn: '30' })
        .previewUrlExpireIn,
    ).toBe('previewExpire');
    expect(
      validateObjectStorageDraft({ ...validObjectStorageDraft(), previewUrlExpireIn: '' })
        .previewUrlExpireIn,
    ).toBeUndefined();
  });
});

describe('validateMailDraft', () => {
  it('accepts a complete SMTP configuration', () => {
    expect(validateMailDraft(validMailDraft())).toEqual({});
  });

  it('rejects a malformed sender address', () => {
    expect(validateMailDraft({ ...validMailDraft(), fromAddress: 'noreply' }).fromAddress).toBe(
      'email',
    );
  });

  it('rejects a port outside 1..65535', () => {
    expect(validateMailDraft({ ...validMailDraft(), port: '70000' }).port).toBe('port');
    expect(validateMailDraft({ ...validMailDraft(), port: '' }).port).toBe('required');
  });

  it('requires the SMTP password again once the destination moved', () => {
    const baseline = validMailDraft();
    for (const moved of [
      { host: 'smtp.other.example.com' },
      { port: '465' },
      { secure: false },
      { user: 'someone-else' },
    ]) {
      expect(validateMailDraft({ ...baseline, ...moved }, baseline).pass).toBe(
        'secretReenterRequired',
      );
    }
  });

  it('accepts a kept SMTP password when only the sender identity changed', () => {
    const baseline = validMailDraft();
    expect(validateMailDraft({ ...baseline, fromAddress: 'other@example.com' }, baseline)).toEqual(
      {},
    );
  });

  it('rejects a credential longer than the contract allows', () => {
    expect(
      validateMailDraft({
        ...validMailDraft(),
        pass: { cleared: false, stored: true, value: 'x'.repeat(513) },
      }).pass,
    ).toBe('secretTooLong');
  });

  it('only asks for the credential of the selected provider', () => {
    const resend = validateMailDraft({ ...validMailDraft(), host: '', provider: 'resend' });
    expect(resend).toEqual({ resendApiKey: 'secretRequired' });

    const smtp = validateMailDraft({
      ...validMailDraft(),
      pass: { cleared: true, stored: true, value: '' },
    });
    expect(smtp).toEqual({ pass: 'secretRequired' });
  });
});

describe('config payloads', () => {
  it('omits blank optional fields and trims the rest', () => {
    const config = toObjectStorageConfig({
      ...validObjectStorageDraft(),
      bucket: '  files  ',
      previewUrlExpireIn: '',
      publicDomain: '   ',
    });

    expect(config).toEqual({
      accessKeyId: 'AKIAFULLVALUE',
      bucket: 'files',
      enabled: true,
      endpoint: 'https://s3.example.com',
      forcePathStyle: true,
      region: 'us-east-1',
      secretAccessKey: { action: 'keep' },
      setAcl: false,
    });
  });

  it('sends only the sub-object of the selected mail provider', () => {
    expect(toMailConfig(validMailDraft())).toEqual({
      enabled: true,
      fromAddress: 'noreply@example.com',
      provider: 'smtp',
      senderName: 'Platform',
      smtp: {
        host: 'smtp.example.com',
        pass: { action: 'keep' },
        port: 587,
        secure: true,
        user: 'mailer',
      },
    });

    const resend = toMailConfig({
      ...validMailDraft(),
      provider: 'resend',
      resendApiKey: { cleared: false, stored: false, value: 're_key' },
    });
    expect(resend).toMatchObject({
      enabled: true,
      resend: { apiKey: { action: 'replace', value: 're_key' } },
    });
    expect(resend).not.toHaveProperty('smtp');
  });
});

describe('disable payloads', () => {
  it('carries the known values and never a credential change', () => {
    expect(toObjectStorageDisableConfig(validObjectStorageDraft())).toEqual({
      accessKeyId: 'AKIAFULLVALUE',
      bucket: 'files',
      enabled: false,
      endpoint: 'https://s3.example.com',
      forcePathStyle: true,
      previewUrlExpireIn: 7200,
      region: 'us-east-1',
      secretAccessKey: { action: 'keep' },
      setAcl: false,
    });
  });

  /** The fail-open case: the override is on, but almost nothing about it is readable. */
  it('still produces a payload when the readable configuration is incomplete', () => {
    const config = toObjectStorageDisableConfig({
      ...validObjectStorageDraft(),
      accessKeyId: '',
      bucket: '',
      endpoint: '',
      previewUrlExpireIn: '',
      region: '',
      secretAccessKey: { cleared: false, stored: false, value: '' },
    });

    expect(config).toEqual({
      enabled: false,
      forcePathStyle: true,
      secretAccessKey: { action: 'keep' },
      setAcl: false,
    });
  });

  it('drops values that are present but malformed rather than sending them', () => {
    const config = toObjectStorageDisableConfig({
      ...validObjectStorageDraft(),
      endpoint: 'not a url',
      previewUrlExpireIn: '5',
      publicDomain: 'ftp://files.example.com',
    });

    expect(config).not.toHaveProperty('endpoint');
    expect(config).not.toHaveProperty('publicDomain');
    expect(config).not.toHaveProperty('previewUrlExpireIn');
    expect(config.bucket).toBe('files');
  });

  it('keeps the SMTP destination whole, or omits it entirely', () => {
    expect(toMailDisableConfig(validMailDraft())).toEqual({
      enabled: false,
      fromAddress: 'noreply@example.com',
      provider: 'smtp',
      senderName: 'Platform',
      smtp: {
        host: 'smtp.example.com',
        pass: { action: 'keep' },
        port: 587,
        secure: true,
        user: 'mailer',
      },
    });

    const partial = toMailDisableConfig({ ...validMailDraft(), host: '', port: '' });
    expect(partial).not.toHaveProperty('smtp');
    expect(partial.enabled).toBe(false);
  });

  it('never asks to change the Resend credential when disabling', () => {
    expect(
      toMailDisableConfig({
        ...validMailDraft(),
        provider: 'resend',
        resendApiKey: { cleared: true, stored: true, value: 'typed-but-irrelevant' },
      }),
    ).toMatchObject({ enabled: false, resend: { apiKey: { action: 'keep' } } });
  });
});

describe('fingerprintObjectStorageDraft', () => {
  it('ignores the typed secret itself but reacts to the intent changing', () => {
    const base = validObjectStorageDraft();
    const typedA = { ...base, secretAccessKey: { cleared: false, stored: true, value: 'a' } };
    const typedB = { ...base, secretAccessKey: { cleared: false, stored: true, value: 'bb' } };

    expect(fingerprintObjectStorageDraft(typedA)).toBe(fingerprintObjectStorageDraft(typedB));
    expect(fingerprintObjectStorageDraft(typedA)).not.toBe(fingerprintObjectStorageDraft(base));
  });
});
