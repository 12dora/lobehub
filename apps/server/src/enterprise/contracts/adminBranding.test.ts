import { describe, expect, it } from 'vitest';

import {
  adminBrandingGetOutputSchema,
  adminBrandingPayloadSchema,
  adminBrandingSaveInputSchema,
  adminBrandingUploadAssetInputSchema,
  adminBrandingUploadAssetOutputSchema,
} from './adminBranding';

const payload = {
  defaultAgentDisplayName: null,
  desktop: { iconUrl: null, productName: null },
  emailFrom: null,
  emailSenderName: null,
  faviconUrl: null,
  homeUrl: null,
  iconUrl: null,
  legalName: null,
  logoUrl: null,
  name: 'Acme',
  ogImageUrl: null,
  pageTitleTemplate: null,
  privacyUrl: null,
  shortName: null,
  supportUrl: null,
  termsUrl: null,
  themeDefaults: { primaryColor: null },
};

describe('adminBranding contracts', () => {
  it('accepts only controlled uploaded asset URLs', () => {
    expect(
      adminBrandingPayloadSchema.safeParse({
        ...payload,
        logoUrl: '/f/pba_11111111-1111-4111-8111-111111111111',
      }).success,
    ).toBe(true);
    for (const logoUrl of [
      'javascript:alert(1)',
      'data:image/png;base64,aaa',
      'https://attacker.example/logo.png',
      '/logo.svg',
      '/f/not/one-id',
      '/f/pba_111111111111-4111-8111-111111111111',
      '/f/pba_11111111-1111-4111-7111-111111111111',
      '/f/pba_11111111-1111-4111-8111-11111111111A',
    ]) {
      expect(adminBrandingPayloadSchema.safeParse({ ...payload, logoUrl }).success).toBe(false);
    }
  });

  it.each([
    ['shortName', '<script>alert(1)</script>'],
    ['legalName', 'Acme\u0000Ltd'],
    ['defaultAgentDisplayName', 'Acme\u202EAdmin'],
    ['pageTitleTemplate', '<b>%s</b>'],
    ['emailSenderName', 'Acme\u2066Mail'],
  ])('reuses shared safe-text validation for %s', (field, value) => {
    expect(adminBrandingPayloadSchema.safeParse({ ...payload, [field]: value }).success).toBe(
      false,
    );
  });

  it('normalizes shared public text and desktop productName identically', () => {
    const parsed = adminBrandingPayloadSchema.parse({
      ...payload,
      desktop: { iconUrl: null, productName: '  Cafe\u0301 Desktop  ' },
      shortName: '  Cafe\u0301  ',
    });
    expect(parsed.shortName).toBe('Café');
    expect(parsed.desktop.productName).toBe('Café Desktop');
  });

  it('carries both CAS handles and rejects unknown fields or a non-UUID idempotency key', () => {
    expect(
      adminBrandingSaveInputSchema.safeParse({
        branding: payload,
        expectedRevision: 0,
        expectedToken: '0'.repeat(64),
        reason: 'save',
        requestId: crypto.randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      adminBrandingSaveInputSchema.safeParse({
        branding: payload,
        expectedRevision: 0,
        expectedToken: '0'.repeat(64),
        reason: 'save',
        requestId: crypto.randomUUID(),
        secret: 'must not pass',
      }).success,
    ).toBe(false);
    for (const missing of ['expectedRevision', 'expectedToken'] as const) {
      const input: Record<string, unknown> = {
        branding: payload,
        expectedRevision: 0,
        expectedToken: '0'.repeat(64),
        reason: 'save',
        requestId: crypto.randomUUID(),
      };
      delete input[missing];
      expect(adminBrandingSaveInputSchema.safeParse(input).success).toBe(false);
    }
    expect(
      adminBrandingSaveInputSchema.safeParse({
        branding: payload,
        expectedRevision: 0,
        expectedToken: '0'.repeat(64),
        reason: '',
        requestId: 'not-uuid',
      }).success,
    ).toBe(false);
  });

  it('serves the live payload with its revision, CAS token and audit trailer', () => {
    const parsed = adminBrandingGetOutputSchema.safeParse({
      branding: payload,
      revision: 3,
      storageConfigured: true,
      token: '0'.repeat(64),
      updatedAt: '2026-08-16T00:00:00.000Z',
      updatedBy: null,
    });
    expect(parsed.success).toBe(true);
    expect(
      adminBrandingGetOutputSchema.safeParse({
        branding: payload,
        revision: 3,
        revisions: [],
        storageConfigured: true,
        token: '0'.repeat(64),
        updatedAt: null,
        updatedBy: null,
      }).success,
    ).toBe(false);
  });

  it('rejects secret material in save and upload reasons', () => {
    const secretReason = 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345';
    expect(
      adminBrandingSaveInputSchema.safeParse({
        branding: payload,
        expectedRevision: 0,
        expectedToken: '0'.repeat(64),
        reason: secretReason,
        requestId: crypto.randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      adminBrandingUploadAssetInputSchema.safeParse({
        bytesBase64: 'AAAA',
        fileName: 'logo.png',
        kind: 'logo',
        reason: secretReason,
        requestId: crypto.randomUUID(),
      }).success,
    ).toBe(false);
  });

  it('caps inline upload envelopes before decoding', () => {
    expect(
      adminBrandingUploadAssetInputSchema.safeParse({
        bytesBase64: 'A'.repeat(8_000_001),
        fileName: 'logo.png',
        kind: 'logo',
        reason: 'upload',
        requestId: crypto.randomUUID(),
      }).success,
    ).toBe(false);
  });

  it('does not advertise ICO in the first-version upload result contract', () => {
    expect(
      adminBrandingUploadAssetOutputSchema.safeParse({
        height: 32,
        mimeType: 'image/x-icon',
        orphanPolicy: 'bounded_sweep',
        url: '/f/pba_11111111-1111-4111-8111-111111111111',
        width: 32,
      }).success,
    ).toBe(false);
  });
});
