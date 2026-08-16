import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AdminBrandingPayload } from '@/enterprise/client/services/adminBranding';

import { BrandingPreview } from './BrandingPreview';

const branding: AdminBrandingPayload = {
  defaultAgentDisplayName: null,
  desktop: { iconUrl: null, productName: null },
  emailFrom: null,
  emailSenderName: null,
  faviconUrl: null,
  homeUrl: null,
  iconUrl: null,
  legalName: null,
  logoUrl: '/f/safe-logo',
  name: '<script>alert(1)</script>',
  ogImageUrl: null,
  pageTitleTemplate: null,
  privacyUrl: null,
  shortName: null,
  supportUrl: null,
  termsUrl: null,
  themeDefaults: { primaryColor: null },
};

describe('BrandingPreview isolation', () => {
  it('uses a scriptless unique-origin sandbox and escapes interpolated text', () => {
    const { getByTitle } = render(
      <BrandingPreview
        branding={branding}
        title="preview"
        copy={{
          defaultAgent: 'Default agent',
          defaultName: 'Example',
          signIn: 'Sign in',
          workspace: 'Workspace',
        }}
      />,
    );
    const frame = getByTitle('preview');
    const source = frame.getAttribute('srcdoc') ?? '';

    expect(frame.getAttribute('sandbox')).toBe('');
    expect(source).not.toMatch(/<script/i);
    expect(source).not.toContain('allow-same-origin');
    expect(source).not.toContain('allow-scripts');
    expect(source).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
