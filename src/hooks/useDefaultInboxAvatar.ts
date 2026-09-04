import { BRANDING_LOGO_URL } from '@lobechat/business-const';
import { DEFAULT_INBOX_AVATAR } from '@lobechat/const';

import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';
import type { RuntimeBranding } from '@/types/platform/branding';

import { useCurrentInboxAgentMeta } from './useCurrentInboxAgent';

/**
 * Avatars that ship with the product: the compile-time builtin inbox image and
 * whatever the build-time branding constant points at. A Published brand may
 * replace them, but never an avatar the user or admin picked themselves.
 */
const BUILT_IN_INBOX_AVATARS = new Set(
  ['/avatars/lobe-ai.png', DEFAULT_INBOX_AVATAR, BRANDING_LOGO_URL].filter(Boolean),
);

type InboxAvatarBranding = Pick<RuntimeBranding, 'iconUrl' | 'logoUrl' | 'publishedRevision'>;

export const resolveDefaultInboxAvatar = (
  branding: InboxAvatarBranding,
  storedAvatar?: string | null,
): string => {
  const stored = storedAvatar?.trim();

  // A customised avatar wins over branding — only the builtin image is replaceable.
  if (stored && !BUILT_IN_INBOX_AVATARS.has(stored)) return stored;

  if (!branding.publishedRevision) return DEFAULT_INBOX_AVATAR;

  return branding.iconUrl?.trim() || branding.logoUrl?.trim() || DEFAULT_INBOX_AVATAR;
};

/** Display-only fallback: the stored inbox avatar always wins when customised. */
export const useDefaultInboxAvatar = (storedAvatar?: string | null): string => {
  const branding = useBranding();

  return resolveDefaultInboxAvatar(branding, storedAvatar);
};

/** Avatar from the Inbox projection owned by the current resolved login scope. */
export const useScopedDefaultInboxAvatar = (): string => {
  const inboxMeta = useCurrentInboxAgentMeta();

  return useDefaultInboxAvatar(inboxMeta?.avatar);
};
