'use client';

import { toast } from '@lobehub/ui/base-ui';
import i18n from 'i18next';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { runAdminMutation } from '@/enterprise/client/features/admin/primitives/runAdminMutation';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import type { AdminAgentsClient } from './types';
import type { AdminAgentRefresh } from './useAdminAgentRefresh';

export interface UseProvisionDefaultInboxParams {
  authMethod: AdminReauthAuthMethod | null;
  /**
   * The pointer read settled with no default assistant AND this operator holds every permission
   * the server's provisioning demands (create + publish + assign). Turning true runs the
   * initialization once, without asking.
   */
  autoProvision: boolean;
  client?: AdminAgentsClient;
  /**
   * The shared both-surfaces invalidator (`useAdminAgentRefresh(...).defaultAndList`): the Agent
   * this writes IS the new default and a table row that did not exist a moment ago.
   */
  refresh: AdminAgentRefresh['defaultAndList'];
}

/**
 * Make sure the platform HAS a default assistant.
 *
 * Every member meets the default assistant first, so its existence is not something an admin opts
 * into — the server provisions it at startup and when this page's list is read, and this is the
 * client-side repair for the window before either has happened. The write is idempotent server
 * side, so it needs no confirmation; it runs at most once per mount and is retried only by click,
 * because the pointer read still says "no default" while the refresh below is in flight and
 * re-firing on that would be an unbounded write loop.
 */
export const useProvisionDefaultInbox = ({
  authMethod,
  autoProvision,
  client = adminAgentsService,
  refresh,
}: UseProvisionDefaultInboxParams) => {
  const { t } = useTranslation('admin');
  const [provisioning, setProvisioning] = useState(false);
  const [failed, setFailed] = useState(false);
  const attempted = useRef(false);
  const inFlight = useRef(false);

  const provision = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    attempted.current = true;
    setProvisioning(true);
    const committed = await runAdminMutation({
      authMethod,
      // The card owns the failure surface: nobody clicked this, so a toast would be an error
      // report with no action next to it. Keep the message where the missing assistant is.
      onError: () => setFailed(true),
      run: async () => {
        // The seeded name / prompt / opening message are written in the admin's own UI
        // language, so the default does not greet every member in English.
        await client.provisionDefaultInbox({
          locale: i18n.resolvedLanguage || i18n.language,
        });
      },
    });
    setProvisioning(false);
    inFlight.current = false;
    if (!committed) return;
    setFailed(false);

    try {
      // Both keys: the pinned card is the whole point of this write, and the table gained a row.
      await refresh();
    } catch {
      toast.warning(t('agentCatalog.recovery.refreshFailed'));
    }
    toast.success(t('agentCatalog.defaultAgent.provision.success'));
  }, [authMethod, client, refresh, t]);

  useEffect(() => {
    if (!autoProvision || attempted.current) return;
    void provision();
  }, [autoProvision, provision]);

  return { failed, provision, provisioning };
};
