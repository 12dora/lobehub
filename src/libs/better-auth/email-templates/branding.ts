import { BRANDING_NAME } from '@lobechat/business-const';

import { appEnv } from '@/envs/app';

export interface EmailBrandingParams {
  /** Canonical application origin used to absolutize root-relative `/f/...` logos. */
  appUrl?: string | null;
  legalName?: string | null;
  logoUrl?: string | null;
  platformName?: string;
}

export interface ResolvedEmailBranding {
  htmlFooter: string;
  htmlLegalName: string;
  htmlLogo: string;
  htmlPlatformName: string;
  legalName: string;
  logoUrl: string | null;
  platformName: string;
}

const escapeHtml = (value: string): string =>
  value.replaceAll(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      '"': '&quot;',
      '&': '&amp;',
      "'": '&#39;',
      '<': '&lt;',
      '>': '&gt;',
    };

    return entities[character] ?? character;
  });

const normalizeOptional = (value?: string | null): string | null => value?.trim() || null;

/**
 * Email clients cannot resolve root-relative `/f/...` upload URLs. Join those
 * against the application origin; leave already-absolute HTTP(S) URLs alone.
 */
export const resolveEmailLogoUrl = (
  logoUrl?: string | null,
  appUrl: string | null | undefined = appEnv.APP_URL,
): string | null => {
  const trimmed = normalizeOptional(logoUrl);
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const isRootRelative = trimmed.startsWith('/') && !trimmed.startsWith('//');
  const origin = normalizeOptional(appUrl);
  if (!isRootRelative || !origin) return null;

  try {
    return new URL(trimmed, origin).href;
  } catch {
    return null;
  }
};

const renderEmailLogo = (htmlPlatformName: string, logoUrl: string | null): string => {
  const mark = logoUrl
    ? `<img alt="${htmlPlatformName}" src="${escapeHtml(logoUrl)}" style="max-height:40px;max-width:180px;object-fit:contain;display:block;" />`
    : `<span style="font-size: 24px; line-height: 1; margin-right: 10px;">🤯</span>
        <span style="font-size: 18px; font-weight: 700; color: #000000; letter-spacing: -0.5px;">${htmlPlatformName}</span>`;

  return `
    <div style="text-align: center; margin-bottom: 32px;">
      <div style="display: inline-flex; align-items: center; justify-content: center; background-color: #ffffff; border-radius: 12px; padding: 8px 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
        ${mark}
      </div>
    </div>`;
};

export const resolveEmailBranding = (
  input: EmailBrandingParams | string = {},
): ResolvedEmailBranding => {
  const params = typeof input === 'string' ? { platformName: input } : input;
  const platformName = normalizeOptional(params.platformName) ?? BRANDING_NAME;
  const legalName = normalizeOptional(params.legalName) ?? platformName;
  const logoUrl = resolveEmailLogoUrl(params.logoUrl, params.appUrl ?? appEnv.APP_URL);
  const htmlPlatformName = escapeHtml(platformName);
  const htmlLegalName = escapeHtml(legalName);

  return {
    htmlFooter: `© ${new Date().getFullYear()} ${htmlLegalName}. All rights reserved.`,
    htmlLegalName,
    htmlLogo: renderEmailLogo(htmlPlatformName, logoUrl),
    htmlPlatformName,
    legalName,
    logoUrl,
    platformName,
  };
};
