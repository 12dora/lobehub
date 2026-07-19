import { describe, expect, it } from 'vitest';

import {
  adminBrandingDraftSchema,
  adminBrandingPublishInputSchema,
  adminBrandingUploadAssetInputSchema,
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
      adminBrandingDraftSchema.safeParse({ ...emptyDraft, logoUrl: '/f/opaque_123' }).success,
    ).toBe(true);
    for (const logoUrl of [
      'javascript:alert(1)',
      'data:image/png;base64,aaa',
      'https://attacker.example/logo.png',
      '/logo.svg',
      '/f/not/one-id',
    ]) {
      expect(adminBrandingDraftSchema.safeParse({ ...emptyDraft, logoUrl }).success).toBe(false);
    }
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
});
