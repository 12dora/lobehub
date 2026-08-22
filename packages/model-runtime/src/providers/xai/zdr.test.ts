import { describe, expect, it } from 'vitest';

import { isXaiZdrFileUnsupportedError } from './zdr';

describe('isXaiZdrFileUnsupportedError', () => {
  it('matches a 4xx policy refusal', () => {
    expect(
      isXaiZdrFileUnsupportedError({
        error: { message: 'File content is currently unsupported for ZDR customers.' },
        status: 400,
      }),
    ).toBe(true);
  });

  it('rejects a 5xx that merely mentions ZDR', () => {
    expect(
      isXaiZdrFileUnsupportedError({
        error: { message: 'ZDR file service unavailable' },
        status: 500,
      }),
    ).toBe(false);
  });

  it('rejects a 429 ZDR rate limit', () => {
    expect(
      isXaiZdrFileUnsupportedError({ message: 'ZDR file upload rate limit exceeded', status: 429 }),
    ).toBe(false);
  });

  it('rejects a 4xx that mentions ZDR and file without a refusal statement', () => {
    expect(
      isXaiZdrFileUnsupportedError({ message: 'ZDR file metadata updated', status: 400 }),
    ).toBe(false);
  });

  it('accepts an unstatused refusal (already-mapped payloads)', () => {
    expect(
      isXaiZdrFileUnsupportedError({
        message: 'zero-data-retention accounts: native file attachments are refused',
      }),
    ).toBe(true);
  });
});
