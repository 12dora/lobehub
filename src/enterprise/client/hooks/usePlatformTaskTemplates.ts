'use client';

import { useTranslation } from 'react-i18next';

import { fetchPlatformTaskTemplates } from '@/enterprise/client/services/platform';
import { useClientDataSWR } from '@/libs/swr';
import type { PlatformTaskTemplateListOutput } from '@/server/enterprise/contracts/adminTaskTemplates';
import { useServerConfigStore } from '@/store/serverConfig';

export const PLATFORM_TASK_TEMPLATES_KEY = 'platform-task-templates';

export interface PlatformTaskTemplatesState extends PlatformTaskTemplateListOutput {
  /**
   * False while the answer is still unknown — either the server config (and therefore the
   * platform-admin flag) has not hydrated yet, or the policy read is in flight.
   * Callers must not fall back to the market list before this flips, otherwise the built-in
   * recommendations flash in for a moment on a platform-managed instance.
   */
  resolved: boolean;
}

const UNMANAGED: PlatformTaskTemplateListOutput = { managed: false, templates: [] };

/**
 * Platform-managed task templates for the current user.
 *
 * Fails open (`managed: false` → keep the market recommendations) so an unavailable policy
 * never empties the home screen. SWR dedupes across every consumer.
 *
 * Default-off: while `enterprise.platformAdmin` is not hydrated/true, no platform RPC is
 * issued and the unmanaged default is returned — matching the server flag gate.
 */
export const usePlatformTaskTemplates = (): PlatformTaskTemplatesState => {
  const { i18n } = useTranslation();
  const serverConfigInit = useServerConfigStore((s) => s.serverConfigInit);
  const platformAdmin = useServerConfigStore(
    (s) => s.serverConfig.enterprise?.platformAdmin === true,
  );
  const enabled = serverConfigInit && platformAdmin;

  // UI locale is forwarded so a first-run auto-seed writes the user's language; it is part of
  // the key so switching language refetches instead of reusing the previous locale's cache.
  const locale = i18n.resolvedLanguage || i18n.language;

  const { data, error } = useClientDataSWR<PlatformTaskTemplateListOutput>(
    enabled ? [PLATFORM_TASK_TEMPLATES_KEY, locale] : null,
    () => fetchPlatformTaskTemplates(locale),
    { revalidateOnFocus: false },
  );

  // Config not hydrated yet: the platform-admin flag is unknown, so the answer is unknown too.
  if (!serverConfigInit) return { ...UNMANAGED, resolved: false };
  // Flag known-off, or the read failed: the market list is the answer (fail open).
  if (!platformAdmin || error) return { ...UNMANAGED, resolved: true };
  // Enabled but no data and no error yet: SWR reports `isLoading: false` on the very first
  // committed frame before the fetch starts, so `!isLoading` would flash the unmanaged
  // fallback at a managed tenant. Until data or error arrives the answer is unknown.
  if (!data) return { ...UNMANAGED, resolved: false };

  return { ...data, resolved: true };
};
