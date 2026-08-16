'use client';

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
  const serverConfigInit = useServerConfigStore((s) => s.serverConfigInit);
  const platformAdmin = useServerConfigStore(
    (s) => s.serverConfig.enterprise?.platformAdmin === true,
  );
  const enabled = serverConfigInit && platformAdmin;

  const { data, error, isLoading } = useClientDataSWR<PlatformTaskTemplateListOutput>(
    enabled ? [PLATFORM_TASK_TEMPLATES_KEY] : null,
    () => fetchPlatformTaskTemplates(),
    { revalidateOnFocus: false },
  );

  // Config not hydrated yet: the platform-admin flag is unknown, so the answer is unknown too.
  if (!serverConfigInit) return { ...UNMANAGED, resolved: false };
  // Flag known-off, or the read failed: the market list is the answer (fail open).
  if (!platformAdmin || error) return { ...UNMANAGED, resolved: true };
  if (!data) return { ...UNMANAGED, resolved: !isLoading };

  return { ...data, resolved: true };
};
