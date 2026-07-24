// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  adminAuthSettingsGetOutputSchema,
  adminAuthSettingsUpdateInputSchema,
} from './adminAuthSettings';

describe('admin auth settings contracts', () => {
  it('requires revision on get and expectedRevision on update', () => {
    expect(
      adminAuthSettingsGetOutputSchema.parse({
        emailDomainAllowlist: [],
        emailDomainAllowlistEnabled: false,
        openRegistration: true,
        revision: 0,
      }).revision,
    ).toBe(0);

    expect(
      adminAuthSettingsUpdateInputSchema.parse({
        emailDomainAllowlist: ['example.com'],
        emailDomainAllowlistEnabled: true,
        expectedRevision: 2,
        openRegistration: false,
      }).expectedRevision,
    ).toBe(2);

    // Stale writers without a CAS token are rejected at the contract boundary.
    expect(
      adminAuthSettingsUpdateInputSchema.safeParse({
        emailDomainAllowlist: [],
        emailDomainAllowlistEnabled: false,
        openRegistration: true,
      }).success,
    ).toBe(false);
  });

  it('rejects enabled allowlisting with empty domains and rejects get without revision', () => {
    expect(
      adminAuthSettingsUpdateInputSchema.safeParse({
        emailDomainAllowlist: [],
        emailDomainAllowlistEnabled: true,
        expectedRevision: 0,
        openRegistration: true,
      }).success,
    ).toBe(false);
    expect(
      adminAuthSettingsGetOutputSchema.safeParse({
        emailDomainAllowlist: [],
        emailDomainAllowlistEnabled: false,
        openRegistration: true,
      }).success,
    ).toBe(false);
  });
});
