import { BRANDING_NAME } from '@lobechat/business-const';

export interface EmailBrandingParams {
  platformName?: string;
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

export const resolveEmailBranding = (platformName = BRANDING_NAME) => ({
  htmlPlatformName: escapeHtml(platformName),
  platformName,
});
