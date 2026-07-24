import { describe, expect, it } from 'vitest';

import {
  isEmailDomainAllowed,
  normalizeEmailDomainAllowlist,
  platformAuthSettingsSchema,
} from './authSettings';

describe('normalizeEmailDomainAllowlist', () => {
  it('splits a raw string on commas / whitespace / newlines and lowercases', () => {
    expect(normalizeEmailDomainAllowlist('Example.com, foo.bar\n *.baz.io')).toEqual([
      'example.com',
      'foo.bar',
      '*.baz.io',
    ]);
  });

  it('strips a leading @ and de-duplicates', () => {
    expect(normalizeEmailDomainAllowlist(['@acme.com', 'acme.com', ' ACME.com '])).toEqual([
      'acme.com',
    ]);
  });

  it('drops empty entries', () => {
    expect(normalizeEmailDomainAllowlist(', ,\n')).toEqual([]);
  });
});

describe('isEmailDomainAllowed', () => {
  it('allows anything when the list is empty', () => {
    expect(isEmailDomainAllowed('anyone@anywhere.com', [])).toBe(true);
  });

  it('matches a bare domain exactly (not its subdomains)', () => {
    expect(isEmailDomainAllowed('a@example.com', ['example.com'])).toBe(true);
    expect(isEmailDomainAllowed('a@mail.example.com', ['example.com'])).toBe(false);
  });

  it('matches *.domain against the base domain and any subdomain', () => {
    expect(isEmailDomainAllowed('a@example.com', ['*.example.com'])).toBe(true);
    expect(isEmailDomainAllowed('a@mail.example.com', ['*.example.com'])).toBe(true);
    expect(isEmailDomainAllowed('a@deep.mail.example.com', ['*.example.com'])).toBe(true);
    expect(isEmailDomainAllowed('a@notexample.com', ['*.example.com'])).toBe(false);
  });

  it('is case-insensitive on the email domain', () => {
    expect(isEmailDomainAllowed('a@Example.COM', ['example.com'])).toBe(true);
  });

  it('rejects malformed / domainless emails', () => {
    expect(isEmailDomainAllowed('no-at-sign', ['example.com'])).toBe(false);
  });
});

describe('platformAuthSettingsSchema', () => {
  it('rejects an invalid domain entry', () => {
    const result = platformAuthSettingsSchema.safeParse({
      emailDomainAllowlist: ['not a domain'],
      emailDomainAllowlistEnabled: true,
      openRegistration: true,
    });
    expect(result.success).toBe(false);
  });

  it('accepts wildcard + bare domains and lowercases them', () => {
    const result = platformAuthSettingsSchema.parse({
      emailDomainAllowlist: ['*.Example.com', 'ACME.io'],
      emailDomainAllowlistEnabled: true,
      openRegistration: false,
    });
    expect(result.emailDomainAllowlist).toEqual(['*.example.com', 'acme.io']);
  });

  it('rejects enabled allowlisting with an empty domain list (fail closed)', () => {
    const result = platformAuthSettingsSchema.safeParse({
      emailDomainAllowlist: [],
      emailDomainAllowlistEnabled: true,
      openRegistration: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.message === 'EMAIL_DOMAIN_ALLOWLIST_REQUIRED'),
      ).toBe(true);
    }
  });

  it('accepts disabled allowlisting with an empty domain list', () => {
    const result = platformAuthSettingsSchema.parse({
      emailDomainAllowlist: [],
      emailDomainAllowlistEnabled: false,
      openRegistration: true,
    });
    expect(result.emailDomainAllowlistEnabled).toBe(false);
    expect(result.emailDomainAllowlist).toEqual([]);
  });
});
