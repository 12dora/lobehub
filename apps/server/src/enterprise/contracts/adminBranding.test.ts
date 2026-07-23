import { describe, expect, it } from 'vitest';

import {
  adminBrandingDraftSchema,
  adminBrandingPublishInputSchema,
  adminBrandingUploadAssetInputSchema,
  adminBrandingUploadAssetOutputSchema,
} from './adminBranding';

const emptyDraft = {
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
      adminBrandingDraftSchema.safeParse({
        ...emptyDraft,
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
      expect(adminBrandingDraftSchema.safeParse({ ...emptyDraft, logoUrl }).success).toBe(false);
    }
  });

  it.each([
    ['shortName', '<script>alert(1)</script>'],
    ['legalName', 'Acme\u0000Ltd'],
    ['defaultAgentDisplayName', 'Acme\u202EAdmin'],
    ['pageTitleTemplate', '<b>%s</b>'],
    ['emailSenderName', 'Acme\u2066Mail'],
  ])('reuses shared safe-text validation for %s', (field, value) => {
    expect(adminBrandingDraftSchema.safeParse({ ...emptyDraft, [field]: value }).success).toBe(
      false,
    );
  });

  it('normalizes shared public text and desktop productName identically', () => {
    const parsed = adminBrandingDraftSchema.parse({
      ...emptyDraft,
      desktop: { iconUrl: null, productName: '  Cafe\u0301 Desktop  ' },
      shortName: '  Cafe\u0301  ',
    });
    expect(parsed.shortName).toBe('Café');
    expect(parsed.desktop.productName).toBe('Café Desktop');
  });

  it('rejects unknown mutation fields and requires reason plus UUID idempotency key', () => {
    expect(
      adminBrandingPublishInputSchema.safeParse({
        expectedDraftToken: '0'.repeat(64),
        expectedRevision: 0,
        reason: 'publish',
        requestId: crypto.randomUUID(),
        secret: 'must not pass',
      }).success,
    ).toBe(false);
    expect(
      adminBrandingPublishInputSchema.safeParse({
        expectedDraftToken: '0'.repeat(64),
        expectedRevision: 0,
        reason: '',
        requestId: 'not-uuid',
      }).success,
    ).toBe(false);
  });

  it('rejects secret material in publication and upload reasons', () => {
    const secretReason = 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345';
    expect(
      adminBrandingPublishInputSchema.safeParse({
        expectedDraftToken: '0'.repeat(64),
        expectedRevision: 0,
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
