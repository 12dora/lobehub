import { describe, expect, it } from 'vitest';

import { extractTotpSecret, rewriteTotpBrand } from './totpUri';

const SECRET = 'JBSWY3DPEHPK3PXP';
const build = (
  label: string,
  query = `secret=${SECRET}&issuer=BuildTimeBrand&algorithm=SHA1&digits=6&period=30`,
) => `otpauth://totp/${label}?${query}`;

describe('rewriteTotpBrand', () => {
  it('replaces both the label issuer and the issuer parameter', () => {
    const result = rewriteTotpBrand(build('BuildTimeBrand:ada@example.com'), 'AIHub');

    expect(result).toBe(
      `otpauth://totp/AIHub:ada%40example.com?secret=${SECRET}&issuer=AIHub&algorithm=SHA1&digits=6&period=30`,
    );
  });

  it('leaves secret, algorithm, digits and period byte-for-byte intact', () => {
    // Padded base32 + an explicit period: URLSearchParams round-tripping would mangle the
    // `=` padding into `%3D`, which not every authenticator decodes back.
    const uri = build('Old:ada', 'secret=NBSWY3DP%3D%3D&digits=8&period=60&algorithm=SHA256');
    const result = rewriteTotpBrand(uri, 'AIHub');

    expect(result).toContain('secret=NBSWY3DP%3D%3D');
    expect(result).toContain('digits=8');
    expect(result).toContain('period=60');
    expect(result).toContain('algorithm=SHA256');
  });

  it('keeps parameter order and only touches issuer', () => {
    const uri = build('Old:ada', `issuer=Old&secret=${SECRET}&digits=6`);

    expect(rewriteTotpBrand(uri, 'New')).toBe(
      `otpauth://totp/New:ada?issuer=New&secret=${SECRET}&digits=6`,
    );
  });

  it('appends an issuer parameter when the URI has none', () => {
    expect(rewriteTotpBrand(`otpauth://totp/Old:ada?secret=${SECRET}`, 'New')).toBe(
      `otpauth://totp/New:ada?secret=${SECRET}&issuer=New`,
    );
  });

  it('handles a percent-encoded colon separator', () => {
    expect(rewriteTotpBrand(`otpauth://totp/Old%3Aada?secret=${SECRET}`, 'New')).toContain(
      'otpauth://totp/New:ada?',
    );
  });

  it('drops the single space the spec allows after the colon', () => {
    expect(rewriteTotpBrand(`otpauth://totp/Old:%20ada?secret=${SECRET}`, 'New')).toContain(
      'otpauth://totp/New:ada?',
    );
  });

  it('treats a label without a colon as the account name', () => {
    expect(rewriteTotpBrand(`otpauth://totp/ada@example.com?secret=${SECRET}`, 'New')).toContain(
      'otpauth://totp/New:ada%40example.com?',
    );
  });

  it('keeps only the first colon as the separator', () => {
    expect(rewriteTotpBrand(`otpauth://totp/Old:a:b?secret=${SECRET}`, 'New')).toContain(
      'otpauth://totp/New:a%3Ab?',
    );
  });

  it('percent-encodes a brand containing spaces and reserved characters', () => {
    const result = rewriteTotpBrand(build('Old:ada'), 'Acme & Co');

    expect(result).toContain('otpauth://totp/Acme%20%26%20Co:ada?');
    expect(result).toContain('issuer=Acme%20%26%20Co');
  });

  it('emits a label without a colon when the source label is empty', () => {
    expect(rewriteTotpBrand(`otpauth://totp/?secret=${SECRET}`, 'New')).toBe(
      `otpauth://totp/New?secret=${SECRET}&issuer=New`,
    );
  });

  it.each([
    ['a non-otpauth URI', 'https://example.com/?issuer=Old'],
    ['an hotp URI', `otpauth://hotp/Old:ada?secret=${SECRET}&counter=1`],
    ['a malformed percent escape in the label', `otpauth://totp/Old%3Aa%ZZ?secret=${SECRET}`],
    ['an empty string', ''],
  ])('returns %s unchanged', (_label, uri) => {
    expect(rewriteTotpBrand(uri, 'New')).toBe(uri);
  });

  it.each([
    ['undefined', undefined as unknown as string],
    ['an empty brand', ''],
    ['a whitespace-only brand', '   '],
  ])('returns the URI unchanged for %s', (_label, brand) => {
    const uri = build('Old:ada');
    expect(rewriteTotpBrand(uri, brand)).toBe(uri);
  });

  it('preserves a trailing fragment', () => {
    expect(rewriteTotpBrand(`otpauth://totp/Old:ada?secret=${SECRET}#frag`, 'New')).toBe(
      `otpauth://totp/New:ada?secret=${SECRET}&issuer=New#frag`,
    );
  });

  it('is idempotent', () => {
    const once = rewriteTotpBrand(build('Old:ada@example.com'), 'AIHub');

    expect(rewriteTotpBrand(once, 'AIHub')).toBe(once);
  });
});

describe('extractTotpSecret', () => {
  it('reads the secret parameter', () => {
    expect(extractTotpSecret(build('Old:ada'))).toBe(SECRET);
  });

  it('decodes a percent-encoded secret', () => {
    expect(extractTotpSecret('otpauth://totp/Old:ada?secret=NBSWY3DP%3D%3D')).toBe('NBSWY3DP==');
  });

  it.each([
    ['a URI with no query', 'otpauth://totp/Old:ada'],
    ['a URI with no secret', 'otpauth://totp/Old:ada?issuer=Old'],
    ['a non-otpauth URI', 'https://example.com/?secret=abc'],
    ['an empty string', ''],
  ])('returns null for %s', (_label, uri) => {
    expect(extractTotpSecret(uri)).toBeNull();
  });
});
