import { describe, expect, it } from 'vitest';

import { normalizeInfraFieldPath, resolveInfraSaveError } from './serverErrors';

const trpcError = (code: string, details?: Record<string, unknown>) => ({
  data: { errorData: { code, details } },
});

describe('normalizeInfraFieldPath', () => {
  it('reduces a contract path to the control name', () => {
    expect(normalizeInfraFieldPath('config.bucket')).toBe('bucket');
    expect(normalizeInfraFieldPath('config.smtp.host')).toBe('host');
  });

  it('points a secret-action rejection at the secret control', () => {
    expect(normalizeInfraFieldPath('config.secretAccessKey.action')).toBe('secretAccessKey');
    expect(normalizeInfraFieldPath('config.smtp.pass.value')).toBe('pass');
  });

  it('returns nothing when the path names no control', () => {
    expect(normalizeInfraFieldPath('config')).toBeUndefined();
    expect(normalizeInfraFieldPath('')).toBeUndefined();
  });
});

describe('resolveInfraSaveError', () => {
  it('reports a CAS mismatch as a conflict rather than a field problem', () => {
    expect(resolveInfraSaveError(trpcError('PLATFORM_REVISION_CONFLICT'))).toEqual({
      conflict: true,
      messageKey: 'systemGeneral.conflict.title',
    });
  });

  it('carries the rejected field through to the form', () => {
    expect(
      resolveInfraSaveError(
        trpcError('PLATFORM_CONFIG_VALIDATION_FAILED', { field: 'config.bucket' }),
      ),
    ).toEqual({
      conflict: false,
      field: 'bucket',
      messageKey: 'systemGeneral.edit.saveRejected',
    });
  });

  it('asks for a credential again when the server refuses to reuse the stored one', () => {
    expect(
      resolveInfraSaveError(trpcError('PLATFORM_INVALID_INPUT', { field: 'config.smtp.pass' })),
    ).toEqual({
      conflict: false,
      field: 'pass',
      messageKey: 'systemGeneral.errors.secretReenterRequired',
    });
  });

  it('maps the Resend credential onto the control that shows it', () => {
    expect(
      resolveInfraSaveError(trpcError('PLATFORM_INVALID_INPUT', { field: 'config.resend.apiKey' }))
        .field,
    ).toBe('resendApiKey');
  });

  it('stays generic for a zodError envelope, which this formatter never emits', () => {
    expect(
      resolveInfraSaveError({ data: { zodError: { fieldErrors: { port: ['bad'] } } } }),
    ).toEqual({ conflict: false, messageKey: 'systemGeneral.edit.saveFailed' });
  });

  it('uses permission copy for a denied write', () => {
    expect(resolveInfraSaveError(trpcError('PLATFORM_PERMISSION_DENIED'))).toEqual({
      conflict: false,
      messageKey: 'systemGeneral.edit.saveForbidden',
    });
  });

  it('falls back to a generic failure for an unclassified error', () => {
    expect(resolveInfraSaveError(new Error('offline'))).toEqual({
      conflict: false,
      messageKey: 'systemGeneral.edit.saveFailed',
    });
  });
});
