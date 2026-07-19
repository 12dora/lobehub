import { DEFAULT_INBOX_TITLE } from '@lobechat/const';

import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';
import type { RuntimeBranding } from '@/types/platform/branding';

export const resolveDefaultInboxDisplayName = (
  configuredTitle: string | null | undefined,
  branding: Pick<RuntimeBranding, 'defaultAgentDisplayName'>,
): string => {
  if (configuredTitle?.trim()) return configuredTitle;

  return branding.defaultAgentDisplayName?.trim() || DEFAULT_INBOX_TITLE;
};

/** User-visible fallback only; the stable inbox id and slug never depend on branding. */
export const useDefaultInboxDisplayName = (configuredTitle?: string | null): string => {
  const branding = useBranding();
  return resolveDefaultInboxDisplayName(configuredTitle, branding);
};
