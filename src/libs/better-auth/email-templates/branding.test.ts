import { describe, expect, it, vi } from 'vitest';

import { resolveEmailBranding, resolveEmailLogoUrl } from './branding';
import { getResetPasswordEmailTemplate } from './reset-password';

const APP_URL = 'https://app.example.test';
const CONTROLLED_LOGO = '/f/pba_01234567-89ab-4cde-8f01-23456789abcd';

vi.mock('@/envs/app', () => ({
  appEnv: { APP_URL: 'https://app.example.test' },
}));

describe('branded email templates', () => {
  it('uses the supplied runtime name and HTML-escapes it', () => {
    const template = getResetPasswordEmailTemplate({
      platformName: 'AI & Hub',
      url: 'https://example.com/reset',
    });

    expect(template.subject).toBe('Reset Your Password - AI & Hub');
    expect(template.html).toContain('AI &amp; Hub');
    expect(template.html).not.toContain('AI & Hub');
    expect(template.html).toContain('🤯');
    expect(template.html).not.toContain('<img');
  });

  it('renders the brand logo and legal-name footer when they are supplied', () => {
    const template = getResetPasswordEmailTemplate({
      legalName: 'Acme <Legal>',
      logoUrl: 'https://cdn.example.com/logo.png',
      platformName: 'Acme',
      url: 'https://example.com/reset',
    });

    expect(template.html).toContain(
      '<img alt="Acme" src="https://cdn.example.com/logo.png" style="max-height:40px;max-width:180px;object-fit:contain;display:block;" />',
    );
    expect(template.html).not.toContain('🤯');
    expect(template.html).toContain(
      `© ${new Date().getFullYear()} Acme &lt;Legal&gt;. All rights reserved.`,
    );
  });
});

describe('resolveEmailBranding', () => {
  it('falls the legal name back to the platform name and escapes both', () => {
    const branding = resolveEmailBranding({ platformName: 'A & B' });

    expect(branding).toMatchObject({
      htmlLegalName: 'A &amp; B',
      htmlPlatformName: 'A &amp; B',
      legalName: 'A & B',
      logoUrl: null,
      platformName: 'A & B',
    });
    expect(branding.htmlFooter).toBe(
      `© ${new Date().getFullYear()} A &amp; B. All rights reserved.`,
    );
    expect(branding.htmlLogo).toContain('🤯');
  });

  it('accepts a bare platform name for existing callers', () => {
    expect(resolveEmailBranding('Solo').platformName).toBe('Solo');
  });

  it('uses the platform name in the footer when legalName is empty', () => {
    const year = new Date().getFullYear();

    expect(resolveEmailBranding({ legalName: '', platformName: 'Acme' }).htmlFooter).toBe(
      `© ${year} Acme. All rights reserved.`,
    );
    expect(resolveEmailBranding({ legalName: '   ', platformName: 'Acme' }).htmlFooter).toBe(
      `© ${year} Acme. All rights reserved.`,
    );
    expect(resolveEmailBranding({ legalName: null, platformName: 'Acme' }).htmlFooter).toBe(
      `© ${year} Acme. All rights reserved.`,
    );
  });

  it('resolves a controlled /f/ logo against APP_URL and leaves absolute URLs untouched', () => {
    expect(resolveEmailLogoUrl(CONTROLLED_LOGO, APP_URL)).toBe(`${APP_URL}${CONTROLLED_LOGO}`);
    expect(resolveEmailLogoUrl('https://cdn.example.com/logo.png', APP_URL)).toBe(
      'https://cdn.example.com/logo.png',
    );

    const branding = resolveEmailBranding({
      logoUrl: CONTROLLED_LOGO,
      platformName: 'Acme',
    });

    expect(branding.logoUrl).toBe(`${APP_URL}${CONTROLLED_LOGO}`);
    expect(branding.htmlLogo).toContain(`src="${APP_URL}${CONTROLLED_LOGO}"`);
    expect(branding.htmlLogo).not.toContain(`src="${CONTROLLED_LOGO}"`);
  });
});

describe('reset-password template logo URL', () => {
  it('emits an absolute application URL for a controlled /f/pba_ logo', () => {
    const template = getResetPasswordEmailTemplate({
      logoUrl: CONTROLLED_LOGO,
      platformName: 'Acme',
      url: 'https://example.com/reset',
    });

    expect(template.html).toContain(
      `<img alt="Acme" src="${APP_URL}${CONTROLLED_LOGO}" style="max-height:40px;max-width:180px;object-fit:contain;display:block;" />`,
    );
    expect(template.html).not.toContain(`src="${CONTROLLED_LOGO}"`);
  });
});
