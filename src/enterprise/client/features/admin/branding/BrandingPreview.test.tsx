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
          emailFrom: 'From',
          home: 'Home',
          links: 'Links',
          primaryColor: 'Primary color',
          privacy: 'Privacy',
          signIn: 'Sign in',
          support: 'Support',
          terms: 'Terms',
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

  it('previews the primary color, public links, and email From line', () => {
    const { getByTitle } = render(
      <BrandingPreview
        title="preview"
        branding={{
          ...branding,
          emailFrom: 'noreply@brand.example',
          emailSenderName: 'Acme Mailer',
          homeUrl: 'https://brand.example.com',
          name: 'Acme',
          privacyUrl: 'https://brand.example.com/privacy',
          supportUrl: 'https://brand.example.com/support',
          termsUrl: 'https://brand.example.com/terms',
          themeDefaults: { primaryColor: '#1677FF' },
        }}
        copy={{
          defaultAgent: 'Default agent',
          defaultName: 'Example',
          emailFrom: 'From',
          home: 'Home',
          links: 'Links',
          primaryColor: 'Primary color',
          privacy: 'Privacy',
          signIn: 'Sign in',
          support: 'Support',
          terms: 'Terms',
          workspace: 'Workspace',
        }}
      />,
    );
    const source = getByTitle('preview').getAttribute('srcdoc') ?? '';

    expect(source).toContain('background:#1677FF');
    expect(source).toContain('#1677FF');
    expect(source).toContain('https://brand.example.com/support');
    expect(source).toContain('https://brand.example.com/privacy');
    expect(source).toContain('https://brand.example.com/terms');
    expect(source).toContain('Acme Mailer &lt;noreply@brand.example&gt;');
  });

  it('does not interpolate an unsafe primary color into CSS', () => {
    const { getByTitle } = render(
      <BrandingPreview
        title="preview"
        branding={{
          ...branding,
          name: 'Acme',
          themeDefaults: { primaryColor: 'red;background:url(https://evil)' as never },
        }}
        copy={{
          defaultAgent: 'Default agent',
          defaultName: 'Example',
          emailFrom: 'From',
          home: 'Home',
          links: 'Links',
          primaryColor: 'Primary color',
          privacy: 'Privacy',
          signIn: 'Sign in',
          support: 'Support',
          terms: 'Terms',
          workspace: 'Workspace',
        }}
      />,
    );
    const source = getByTitle('preview').getAttribute('srcdoc') ?? '';

    expect(source).not.toContain('background:red');
    expect(source).not.toContain('url(https://evil)');
  });
});
